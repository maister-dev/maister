import type {
  WorkspaceWorkloadRequest,
  WorkspaceWorkloadResult,
} from "../../runtime/workspace-prepare";
import type { CommandReceiptRow, HostState } from "./host-state";
import type { RuntimeObjectRegistry } from "./runtime-objects";
import type { RuntimeEventPublisher } from "./runtime-event-publisher";
import type { Logger } from "pino";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  WORKSPACE_FLOW_SETUP_COMMAND,
  WORKSPACE_FLOW_SETUP_ID,
  WORKSPACE_FLOW_SETUP_TIMEOUT_MS,
  WORKSPACE_WORKLOAD_FILE,
  WORKSPACE_WORKLOAD_FILE_MAX_BYTES,
  WORKSPACE_WORKLOAD_KINDS,
  WORKSPACE_WORKLOAD_MAX_COMMAND_LENGTH,
  WORKSPACE_WORKLOAD_MAX_DECLARATIONS,
  WORKSPACE_WORKLOAD_MAX_TIMEOUT_MS,
  WORKSPACE_TEMPLATE_CONTEXT_MAX_BYTES,
  WORKSPACE_TEMPLATE_CONTEXT_NAME,
} from "../../runtime/workspace-prepare";
import { flowTemplateEnvironment } from "../../runtime/flow-template-environment";
import { renderStrict } from "../../runtime/flow-template-render";
import { inspectProcessGroup } from "../../runtime/process-group";

import { SupervisorError } from "./types";
import { readHostProcessContext } from "./session-process-context";
import {
  materializeWorkspaceFlowAssets,
  readRetainedWorkspaceInput,
} from "./workspace-input-materialization";
import { executeWorkspaceWorkloadProcess } from "./workspace-workload-process";
import { sealWorkspaceOutput } from "./workspace-output-object";
import { copyPreparedFlowAssets, runFlowSetup } from "./workspace-flow-setup";

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
        flowAssets: z.literal(true).optional(),
        flowSetup: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u).optional(),
      })
      .strict(),
  )
  .max(WORKSPACE_WORKLOAD_MAX_DECLARATIONS);

const templateContextSchema = z
  .object({
    version: z.literal(1),
    declarationId: z.string(),
    values: z
      .record(z.string(), z.json())
      .refine((values) => !Object.hasOwn(values, "env")),
  })
  .strict();

/** The host executes only its retained template with a sealed, assignment-bound view. */
async function resolveWorkloadCommand(
  objects: RuntimeObjectRegistry,
  request: WorkspaceWorkloadRequest,
  template: string,
): Promise<string> {
  const { owner, payload } = request;
  const reference = payload.templateContext;
  const needsContext =
    ["cli", "check"].includes(payload.workload) && template.includes("{{");
  if (!needsContext && reference === undefined) return template;
  const invalid = () =>
    new SupervisorError(
      "PRECONDITION",
      "Workspace template context is invalid or unavailable",
      {
        details: { reason: "workspace_template_context_invalid" },
      },
    );
  if (!needsContext || !reference) throw invalid();

  const { metadata } = await objects.resolvePromptReference({
    runId: owner.runId,
    assignmentId: owner.assignmentId,
    assignmentEpoch: owner.assignmentEpoch,
    objectId: reference.objectId,
    expectedKind: "capability_profile",
  });
  if (
    metadata.logicalName !== WORKSPACE_TEMPLATE_CONTEXT_NAME ||
    metadata.mimeType !== "application/json" ||
    metadata.sha256 !== reference.sha256 ||
    metadata.sizeBytes == null ||
    metadata.sizeBytes > WORKSPACE_TEMPLATE_CONTEXT_MAX_BYTES
  )
    throw invalid();

  const { stream } = await objects.read(reference.objectId);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
    throw invalid();
  try {
    const context = templateContextSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (context.declarationId !== payload.declarationId) throw invalid();
    const command = renderStrict(
      template,
      { ...context.values, env: flowTemplateEnvironment(process.env) },
      {
        maxLength: WORKSPACE_WORKLOAD_MAX_COMMAND_LENGTH,
      },
    );
    if (command.length === 0 || command.includes("\0")) throw invalid();

    return command;
  } catch {
    throw invalid();
  }
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
  const isSetup = declaration.workload === "setup";
  if ((declaration.flowSetup && !declaration.flowAssets) ||
    (isSetup && (!declaration.flowSetup ||
      declaration.command !== WORKSPACE_FLOW_SETUP_COMMAND ||
      declaration.id !== WORKSPACE_FLOW_SETUP_ID ||
      declaration.timeoutMs > WORKSPACE_FLOW_SETUP_TIMEOUT_MS ||
      declaration.structuredOutput)) ||
    (declaration.flowAssets && declaration.workload === "requirementProbe"))
    throw new SupervisorError(
      "PRECONDITION",
      "Flow package setup or assets do not match the sealed declaration",
    );
  const setupSource = declaration.flowSetup ? {
    inputDirectory,
    manifestDigest: payload.inputDigest,
    runtimeRoot,
    revision: declaration.flowSetup,
    projectSlug: workspace.projectSlug,
    owner,
  } : undefined;
  const command = await resolveWorkloadCommand(
    input.objects,
    request,
    declaration.command,
  );
  assertOwner();
  let processGroup: number | undefined;
  let outputDirectory: string | undefined;
  if (declaration.structuredOutput === "jsonFile" || (declaration.flowAssets && !isSetup)) {
    const outputRoot = join(runDirectory, "workload-results");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    if ((await realpath(outputRoot)) !== outputRoot)
      throw new SupervisorError(
        "PRECONDITION",
        "Workload result root is not canonical",
      );
    outputDirectory = await mkdtemp(join(outputRoot, ".result-"));
  }
  const outputFile =
    outputDirectory && declaration.structuredOutput === "jsonFile"
      ? join(outputDirectory, "output.json")
      : undefined;
  let result: Awaited<ReturnType<typeof executeWorkspaceWorkloadProcess>>;
  let declaredOutput:
    Awaited<ReturnType<typeof readDeclaredResult>> | undefined;
  let canRemoveOutput = true;

  const execute = (cwd: string, flowInstallPath?: string) =>
    executeWorkspaceWorkloadProcess({
      cwd,
      command,
      timeoutMs: declaration.timeoutMs,
      signal: input.signal,
      outputFile,
      flowInstallPath,
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
  try {
    if (isSetup && setupSource) {
      const setup = await runFlowSetup(setupSource, (cwd) => execute(cwd, cwd), assertOwner);
      if (setup.kind === "reused") {
        input.logger.info({ commandId: request.command.id, runId: owner.runId, revision: setupSource.revision }, "workspace-flow-setup-reused");
        return {
          generation: payload.generation,
          exitCode: 0,
          signal: null,
          processOutcome: "exited",
          checkValidity: "notRequested",
          outputState: "sealed",
          objects: [],
          quiescence: "proved",
          setupReused: true,
        };
      }
      result = setup.result;
    } else {
      const flowInstallPath =
        outputDirectory && declaration.flowAssets
          ? setupSource
            ? await copyPreparedFlowAssets(setupSource, outputDirectory)
            : await materializeWorkspaceFlowAssets({
                inputDirectory,
                manifestDigest: payload.inputDigest,
                commandDirectory: outputDirectory,
              })
          : undefined;
      result = await execute(workspace.realPath, flowInstallPath);
    }
    canRemoveOutput = result.retired;
    if (outputFile && result.retired)
      declaredOutput = await readDeclaredResult(outputFile);
  } finally {
    if (outputDirectory && canRemoveOutput)
      await rm(outputDirectory, { recursive: true, force: true });
  }
  const source = { workspaceWorkloadCommandId: request.command.id };
  const objects = [
    await sealWorkspaceOutput(input, owner, {
      logicalName: "workload-stdout.txt",
      mimeType: "text/plain",
      bytes: result.stdout,
      source,
    }),
    await sealWorkspaceOutput(input, owner, {
      logicalName: "workload-stderr.txt",
      mimeType: "text/plain",
      bytes: result.stderr,
      source,
    }),
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
        await sealWorkspaceOutput(input, owner, {
          logicalName: "workload-result.json",
          mimeType: "application/json",
          bytes: declaredOutput.bytes,
          source,
        }),
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
