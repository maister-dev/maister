import type { Logger } from "pino";
import type { WorkspaceResolution } from "./workspace-registry";

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";

import { SESSION_EVENT_CHANNEL } from "./registry";
import {
  type ContextMount,
  SupervisorError,
  type SessionEvent,
  type SessionRecord,
  type StartSessionRequest,
} from "./types";
import { getAdapterRuntime, resolveAdapterBinary } from "./adapter-registry";
import { effectiveStartSessionRequest } from "./runner-provisioner";

const MAX_LINE_BYTES = 1024 * 1024;

type RuntimeObjectEnvName =
  | "MAISTER_OUTPUT_FILE"
  | "MAISTER_PLAN_DOCUMENT_FILE"
  | "MAISTER_PLAN_REVIEW_FILE";
type RuntimeObjectEnvPaths = Partial<Record<RuntimeObjectEnvName, string>>;

export type SpawnSessionOptions = {
  sessionId: string;
  request: StartSessionRequest;
  // ADR-166: every run-dir path and the cwd come from the resolved workspace
  // (the adopted handle) — the single path-derivation site.
  workspace: WorkspaceResolution;
  // ADR-166: the `session.create` command (and its fence) this session is
  // spawned by — stamped on the record for the `GET /sessions` projection and
  // the lower-epoch eviction.
  createdBy: {
    commandId: string;
    assignmentId: string;
    assignmentEpoch: number;
  };
  logger: Logger;
  binaryOverride?: string;
  preArgs?: string[];
  runtimeObjectEnv?: {
    capabilityProfilePath?: string;
    capabilityInstructionsPath?: string;
    outputPaths?: RuntimeObjectEnvPaths;
    outputObjectIds?: string[];
  };
};

export type SpawnSessionResult = {
  child: ChildProcess;
  emitter: EventEmitter;
  record: SessionRecord;
  logPath: string;
  logStream: WriteStream;
  acpStdoutTap: PassThrough;
};

// The request fields the child environment is layered from. The model-catalog
// the subset rather than a full StartSessionRequest.
export type ChildEnvRequest = Pick<
  StartSessionRequest,
  "executor" | "adapterLaunch"
>;

export function buildChildEnv(
  request: ChildEnvRequest,
  opts: {
    contextMounts?: ContextMount[];
    capabilityProfilePath?: string;
    capabilityInstructionsPath?: string;
    outputPaths?: RuntimeObjectEnvPaths;
  } = {},
): NodeJS.ProcessEnv {
  // ADR-166: mounts come from the resolved workspace (the adopted handle) —
  // the request body never carries a path.
  const contextMounts = opts.contextMounts;

  return {
    ...process.env,
    ...(request.executor.env ?? {}),
    ...(request.adapterLaunch?.env ?? {}),
    ...(opts.capabilityProfilePath
      ? { MAISTER_CAPABILITY_PROFILE_PATH: opts.capabilityProfilePath }
      : {}),
    ...(opts.capabilityInstructionsPath
      ? {
          MAISTER_CAPABILITY_INSTRUCTIONS_PATH: opts.capabilityInstructionsPath,
        }
      : {}),
    // ADR-157 (D8b): self-describing JSON array of the request's mounts — a
    // `:`-joined path list would drop the slug and the resolved commit, the two
    // fields a consumer wants. Request-derived like MAISTER_CAPABILITY_PROFILE_PATH
    // above, never an executor.env overload. Omitted entirely when the session has
    // no mounts (never an empty array). Reaches the ACP child ONLY — cli/check
    // children run under the ADR-153 allow-list, which excludes this var.
    ...(contextMounts && contextMounts.length > 0
      ? { MAISTER_CONTEXT_REPOS: JSON.stringify(contextMounts) }
      : {}),
    ...(opts.outputPaths ?? {}),
  };
}

export async function spawnSession(
  opts: SpawnSessionOptions,
): Promise<SpawnSessionResult> {
  const { sessionId, logger } = opts;
  const request = effectiveStartSessionRequest(opts.request);
  const workspace = opts.workspace;
  const adapterRuntime = getAdapterRuntime(request.executor.agent);
  const binaryResolution = resolveAdapterBinary({
    adapter: request.executor.agent,
    testOverride: opts.binaryOverride,
  });
  const binary = binaryResolution.binary;

  // The host owns its step log; canonical session events are persisted to the
  // host outbox instead of a shared per-run file.
  const { logPath } = workspace;

  await mkdir(dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });
  const seedMonotonicId = 0;
  // M42 (ADR-114): a single-session run omits sessionName → "default".
  const sessionName = request.sessionName ?? "default";

  const args: string[] = [
    ...adapterRuntime.defaultArgs,
    ...(opts.preArgs ?? []),
  ];

  if (request.adapterLaunch?.preArgs) {
    args.push(...request.adapterLaunch.preArgs);
  }

  // Resume is performed at the ACP protocol level via session/resume (see
  // createAcpConnection), NOT a CLI flag: both claude-agent-acp and codex-acp
  // ignore `--resume` on argv. request.resumeSessionId still drives the cost
  // `resumed` marker below and is forwarded to createAcpConnection.

  if (request.adapterLaunch?.postArgs) {
    args.push(...request.adapterLaunch.postArgs);
  }

  const childEnv = buildChildEnv(request, {
    contextMounts: workspace.contextMounts,
    capabilityProfilePath: opts.runtimeObjectEnv?.capabilityProfilePath,
    capabilityInstructionsPath:
      opts.runtimeObjectEnv?.capabilityInstructionsPath,
    outputPaths: opts.runtimeObjectEnv?.outputPaths,
  });

  logger.info(
    {
      sessionId,
      agent: request.executor.agent,
      adapter: adapterRuntime.id,
      binary,
      binarySource: binaryResolution.source,
      binaryOverrideEnv: binaryResolution.overrideEnv ?? null,
      model: request.executor.model,
      cwd: workspace.cwd,
      executionWorkspaceId: workspace.executionWorkspaceId,
      resume: Boolean(request.resumeSessionId),
      runnerId: opts.request.runner?.runnerId ?? null,
      runnerProvider: opts.request.runner?.provider.kind ?? null,
      hasEnv: Boolean(
        request.executor.env && Object.keys(request.executor.env).length > 0,
      ),
      envKeys: Object.keys(request.executor.env ?? {}).sort(),
      hasAdapterEnv: Boolean(
        request.adapterLaunch?.env &&
          Object.keys(request.adapterLaunch.env).length > 0,
      ),
      adapterEnvKeys: Object.keys(request.adapterLaunch?.env ?? {}).sort(),
      hasCapabilityProfile: Boolean(
        opts.runtimeObjectEnv?.capabilityProfilePath,
      ),
      hasCapabilityInstructions: Boolean(
        opts.runtimeObjectEnv?.capabilityInstructionsPath,
      ),
      runtimeOutputEnvNames: Object.keys(
        opts.runtimeObjectEnv?.outputPaths ?? {},
      ).sort(),
    },
    "spawn",
  );

  const child = spawn(binary, args, {
    cwd: workspace.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "inherit"],
  });

  await new Promise<void>((resolveP, rejectP) => {
    const onError = (err: Error) => {
      child.off("spawn", onSpawn);
      logStream.end();
      logger.warn(
        {
          sessionId,
          agent: request.executor.agent,
          errno: (err as NodeJS.ErrnoException).code,
        },
        "spawn-failed",
      );
      rejectP(
        new SupervisorError("SPAWN", `spawn ${binary} failed: ${err.message}`, {
          cause: err,
        }),
      );
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolveP();
    };

    child.once("error", onError);
    child.once("spawn", onSpawn);
  });

  const pid = child.pid;

  if (pid === undefined) {
    logStream.end();
    throw new SupervisorError("SPAWN", "child has no pid after spawn");
  }

  const record: SessionRecord = {
    sessionId,
    adapter: adapterRuntime.id,
    runId: workspace.runId,
    projectSlug: workspace.projectSlug,
    stepId: request.stepId,
    nodeAttemptId: request.nodeAttemptId,
    sessionName,
    status: "live",
    pid,
    startedAt: new Date().toISOString(),
    logPath,
    worktreePath: workspace.cwd,
    repoPath: workspace.repoPath,
    confineRoot: workspace.confineRoot,
    executionWorkspaceId: workspace.executionWorkspaceId,
    assignmentId: opts.createdBy.assignmentId,
    assignmentEpoch: opts.createdBy.assignmentEpoch,
    createdByCommandId: opts.createdBy.commandId,
    monotonicId: seedMonotonicId,
    // M34 (ADR-090 L1): session-scoped read-only permission arbitration.
    readOnlySession: request.readOnlySession === true,
    // B1 (execution-policy permissions=auto_approve): inline L3 auto-approve.
    autoApprovePermissions: request.autoApprovePermissions === true,
    // ADR-108 (M40): arm the universal guardrail interceptor with the web tier's
    // resolved rule set. Counters start fresh (in-memory only; a resume rebuilds
    // this record, so a resumed run counts from zero).
    hooksConfig: request.hooksConfig,
    // ADR-130: arm the capability_guard interceptor with the web-derived profile.
    // Counters start fresh (in-memory; a resume rebuilds this record from zero).
    enforcementProfile: request.enforcementProfile,
    // ADR-157: arm the unconditional read-only mount guard + the prompt preamble
    // with the mounts the web tier materialized for this session.
    contextMounts: workspace.contextMounts,
    runtimeOutputObjectIds: opts.runtimeObjectEnv?.outputObjectIds,
    capabilityDenyCount: 0,
    capabilityPendingWriteIds: new Set<string>(),
    repeatCount: 0,
    turnsSinceProgress: 0,
  };

  const emitter = new EventEmitter();

  emitter.setMaxListeners(0);
  const lineEmitter = (monotonicId: number, line: string) => {
    const event: SessionEvent = {
      type: "session.line",
      sessionId,
      monotonicId,
      line,
    };

    emitter.emit(SESSION_EVENT_CHANNEL, event);
  };

  let buffer = "";

  const acpStdoutTap = new PassThrough();

  acpStdoutTap.setMaxListeners(0);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    logStream.write(chunk);
    acpStdoutTap.write(chunk);
    buffer += chunk;

    if (buffer.length > MAX_LINE_BYTES) {
      logger.warn(
        { sessionId, len: buffer.length, cap: MAX_LINE_BYTES },
        "line-buffer-overflow",
      );
      record.monotonicId += 1;
      lineEmitter(record.monotonicId, buffer.slice(0, MAX_LINE_BYTES));
      buffer = "";

      return;
    }

    let nl = buffer.indexOf("\n");

    while (nl !== -1) {
      const line = buffer.slice(0, nl);

      buffer = buffer.slice(nl + 1);
      record.monotonicId += 1;
      lineEmitter(record.monotonicId, line);
      logger.debug(
        { sessionId, monotonicId: record.monotonicId, len: line.length },
        "stdout-line",
      );
      nl = buffer.indexOf("\n");
    }
  });

  child.stdout?.on("end", () => {
    if (buffer.length > 0) {
      record.monotonicId += 1;
      lineEmitter(record.monotonicId, buffer);
      buffer = "";
    }
    acpStdoutTap.end();
    logStream.end();
  });

  child.stdout?.on("error", (err) => {
    logger.warn({ sessionId, err: err.message }, "stdout-error");
  });

  return {
    child,
    emitter,
    record,
    logPath,
    logStream,
    acpStdoutTap,
  };
}
