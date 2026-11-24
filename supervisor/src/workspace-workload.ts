import type {
  WorkspaceInputObject,
  WorkspaceWorkloadRequest,
  WorkspaceWorkloadResult,
} from "../../runtime/workspace-prepare";
import type { CommandReceiptRow, HostState } from "./host-state";
import type { RuntimeObjectRegistry } from "./runtime-objects";
import type { RuntimeEventPublisher } from "./runtime-event-publisher";
import type { Logger } from "pino";

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  WORKSPACE_WORKLOAD_FILE,
  WORKSPACE_WORKLOAD_FILE_MAX_BYTES,
  WORKSPACE_WORKLOAD_KINDS,
  WORKSPACE_WORKLOAD_MAX_COMMAND_LENGTH,
  WORKSPACE_WORKLOAD_MAX_DECLARATIONS,
  WORKSPACE_WORKLOAD_MAX_TIMEOUT_MS,
} from "../../runtime/workspace-prepare";
import { inspectProcessGroup } from "../../runtime/process-group";

import { SupervisorError } from "./types";
import { readHostProcessContext } from "./session-process-context";
import { readRetainedWorkspaceInput } from "./workspace-input-materialization";
import { executeWorkspaceWorkloadProcess } from "./workspace-workload-process";

const declarationsSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
        workload: z.enum(WORKSPACE_WORKLOAD_KINDS),
        command: z
          .string()
          .min(1)
          .max(WORKSPACE_WORKLOAD_MAX_COMMAND_LENGTH)
          .refine((command) => !command.includes("\0")),
        timeoutMs: z
          .number()
          .int()
          .min(1)
          .max(WORKSPACE_WORKLOAD_MAX_TIMEOUT_MS),
        structuredOutput: z.enum(["json", "jsonFile"]).optional(),
      })
      .strict(),
  )
  .max(WORKSPACE_WORKLOAD_MAX_DECLARATIONS);

async function sealOutput(
  args: Readonly<{
    objects: RuntimeObjectRegistry;
    events: RuntimeEventPublisher;
    state: HostState;
  }>,
  owner: WorkspaceWorkloadRequest["owner"],
  commandId: string,
  name: string,
  bytes: Buffer,
): Promise<WorkspaceInputObject> {
  const objectId = randomUUID();
  const generation = 1;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { runId, assignmentId, assignmentEpoch } = owner;
  await args.objects.reserve({
    runId,
    assignmentId,
    assignmentEpoch,
    payload: {
      objectId,
      kind: "diagnostic",
      logicalName: name,
      mimeType: name.endsWith(".json") ? "application/json" : "text/plain",
      retentionClass: "run",
      generation,
      sizeBytes: bytes.byteLength,
      sha256,
    },
  });
  const metadata = await args.objects.upload({
    objectId,
    assignmentId,
    assignmentEpoch,
    generation,
    sha256,
    sizeBytes: bytes.byteLength,
    chunks: (async function* () {
      yield bytes;
    })(),
  });
  const available = args.events.runtimeObjectInput({
    runId,
    assignmentId,
    assignmentEpoch,
    metadata,
  });
  args.state.appendRuntimeEvent({
    ...available,
    draft: {
      ...available.draft,
      payload: {
        ...available.draft.payload,
        workspaceWorkloadCommandId: commandId,
      },
    },
  });

  return { objectId, sha256 };
}

async function readDeclaredResult(
  path: string,
): Promise<
  { kind: "absent" | "invalid" } | { kind: "present"; bytes: Buffer }
> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      return { kind: "invalid" };
    throw error;
  }
  const buffer = Buffer.alloc(262_145);
  try {
    if (!(await file.stat()).isFile()) return { kind: "invalid" };
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }

    return length > 262_144
      ? { kind: "invalid" }
      : { kind: "present", bytes: buffer.subarray(0, length) };
  } finally {
    await file.close();
  }
}

function jsonValidity(bytes: Uint8Array): "valid" | "invalid" {
  try {
    JSON.parse(
      Buffer.from(bytes)
        .toString("utf8")
        .replace(/^\uFEFF/u, ""),
    );

    return "valid";
  } catch {
    return "invalid";
  }
}

export async function runWorkspaceWorkload(
  input: Readonly<{
    request: WorkspaceWorkloadRequest;
    state: HostState;
    objects: RuntimeObjectRegistry;
    events: RuntimeEventPublisher;
    handle: string;
    runtimeRoot: string;
    assertOwner: () => void;
    signal: AbortSignal;
    logger: Logger;
  }>,
): Promise<WorkspaceWorkloadResult> {
  const { state, handle, request, assertOwner, runtimeRoot } = input;
  const workspace = state.getWorkspace(handle);
  const retained = state.getWorkspaceExecutionState(handle);
  const { payload, owner } = request;
  if (
    !workspace ||
    workspace.runId !== owner.runId ||
    workspace.releasedAt ||
    retained?.generation !== payload.generation ||
    retained.materializationGeneration !== payload.inputGeneration ||
    retained.materializationDigest !== payload.inputDigest
  )
    throw new SupervisorError(
      "FENCED",
      "Workload workspace inputs have changed",
      {
        details: { reason: "stale_workspace_generation" },
      },
    );
  if ((await realpath(workspace.realPath)) !== workspace.realPath)
    throw new SupervisorError(
      "PRECONDITION",
      "Workload directory no longer matches its canonical root",
      {
        details: { reason: "workspace_rejected" },
      },
    );
  const runDirectory = join(
    await realpath(runtimeRoot),
    ".maister",
    workspace.projectSlug,
    "runs",
    workspace.runId,
  );
  const inputDirectory = join(runDirectory, "inputs", payload.inputDigest);
  const bytes = await readRetainedWorkspaceInput(
    inputDirectory,
    payload.inputDigest,
    WORKSPACE_WORKLOAD_FILE,
    WORKSPACE_WORKLOAD_FILE_MAX_BYTES,
  );
  const declarations = (() => {
    if (!bytes) return null;
    try {
      return declarationsSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  })();
  const matches = declarations?.success
    ? declarations.data.filter(
        ({ id, workload }) =>
          id === payload.declarationId && workload === payload.workload,
      )
    : [];
  if (matches.length !== 1)
    throw new SupervisorError(
      "PRECONDITION",
      "Workload does not match a single sealed declaration",
      {
        details: { reason: "tool_not_declared" },
      },
    );
  const [declaration] = matches;
  assertOwner();
  let processGroup: number | undefined;
  let outputDirectory: string | undefined;
  if (declaration.structuredOutput === "jsonFile") {
    const outputRoot = join(runDirectory, "workload-results");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    if ((await realpath(outputRoot)) !== outputRoot)
      throw new SupervisorError(
        "PRECONDITION",
        "Workload result root is not canonical",
      );
    outputDirectory = await mkdtemp(join(outputRoot, ".result-"));
  }
  const outputFile = outputDirectory
    ? join(outputDirectory, "output.json")
    : undefined;
  let result: Awaited<ReturnType<typeof executeWorkspaceWorkloadProcess>>;
  let declaredOutput:
    Awaited<ReturnType<typeof readDeclaredResult>> | undefined;
  let canRemoveOutput = true;

  try {
    result = await executeWorkspaceWorkloadProcess({
      cwd: workspace.realPath,
      command: declaration.command,
      timeoutMs: declaration.timeoutMs,
      signal: input.signal,
      outputFile,
      register: (pid) => {
        assertOwner();
        const physicalKey = createHash("sha256")
          .update(workspace.realPath)
          .digest("hex");
        if (
          !state.recordWorkspaceWorkloadProcess(
            request.command.id,
            pid,
            physicalKey,
          )
        )
          throw new SupervisorError(
            "CONFLICT",
            "The workload lost its assignment or another group owns the workspace",
            {
              details: { reason: "workspace_in_use" },
            },
          );
        processGroup = pid;
        canRemoveOutput = false;
      },
    });
    canRemoveOutput = result.retired;
    if (outputFile && result.retired)
      declaredOutput = await readDeclaredResult(outputFile);
  } finally {
    if (outputDirectory && canRemoveOutput)
      await rm(outputDirectory, { recursive: true, force: true });
  }
  const objects = [
    await sealOutput(
      input,
      owner,
      request.command.id,
      "workload-stdout.txt",
      result.stdout,
    ),
    await sealOutput(
      input,
      owner,
      request.command.id,
      "workload-stderr.txt",
      result.stderr,
    ),
  ];
  let checkValidity: WorkspaceWorkloadResult["checkValidity"] = "notRequested";
  if (declaration.structuredOutput === "json") {
    checkValidity =
      !result.truncated && result.processOutcome === "exited"
        ? jsonValidity(result.stdout)
        : "unavailable";
  } else if (declaration.structuredOutput === "jsonFile") {
    checkValidity =
      declaredOutput?.kind === "invalid" ? "invalid" : "unavailable";
    if (declaredOutput?.kind === "present") {
      checkValidity = jsonValidity(declaredOutput.bytes);
      objects.push(
        await sealOutput(
          input,
          owner,
          request.command.id,
          "workload-result.json",
          declaredOutput.bytes,
        ),
      );
    }
  }

  input.logger.info(
    {
      runId: owner.runId,
      commandId: request.command.id,
      hostKey: owner.hostKey,
      assignmentEpoch: owner.assignmentEpoch,
      processGroup,
      processOutcome: result.processOutcome,
      exitCode: result.exitCode,
      quiescence: result.retired ? "proved" : "uncertain",
      outputObjectIds: objects.map(({ objectId }) => objectId),
    },
    "workspace-workload-settled",
  );
  return {
    generation: payload.generation,
    processOutcome: result.processOutcome,
    exitCode: result.exitCode,
    signal: result.signal,
    checkValidity,
    outputState: result.truncated ? "truncated" : "sealed",
    objects,
    quiescence: result.retired ? "proved" : "uncertain",
  };
}

const persistedProcess = z
  .object({
    group: z.number().int().positive(),
    physicalKey: z.string().regex(/^[a-f0-9]{64}$/),
    osBootIdentity: z.string().uuid(),
    pidNamespace: z.string().min(1).max(64),
  })
  .strict();

/** A supervisor restart never repeats a shell that may have passed its gate. */
export async function recoverWorkspaceWorkload(
  receipt: CommandReceiptRow,
  generation: number,
): Promise<WorkspaceWorkloadResult | null> {
  const witness = (receipt.body as { workspaceProcess?: unknown })
    .workspaceProcess;
  let quiescence: WorkspaceWorkloadResult["quiescence"] = "proved";
  if (witness !== undefined) {
    const process = persistedProcess.safeParse(witness);
    const current = readHostProcessContext();

    if (!process.success) quiescence = "uncertain";
    else if (process.data.osBootIdentity === current.osBootIdentity) {
      if (process.data.pidNamespace !== current.pidNamespace) {
        quiescence = "uncertain";
      } else {
        const observed = await inspectProcessGroup(process.data.group);
        // Keep the accepted receipt and its group fence while the same native
        // group is still visible. Replaying the command can later observe retirement.
        if (observed.state === "active") return null;
        if (observed.state === "unavailable") quiescence = "uncertain";
      }
    }
  }

  return {
    generation,
    processOutcome: "interrupted",
    exitCode: null,
    signal: null,
    checkValidity: "unavailable",
    outputState: "unavailable",
    objects: [],
    quiescence,
  };
}
