import type { Logger } from "pino";
import type { WorkspaceResolution } from "./workspace-registry";

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open as openFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";

import { openEventsLog, type EventsLogWriter } from "./events-log";
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
const TAIL_SCAN_BYTES = 64 * 1024;

// Scan the tail of an events.jsonl file to find the highest monotonicId
// previously emitted for this run. Used to seed `record.monotonicId`
// on each spawn so multi-session runs (slash-in-existing, or several
// new-session-per-step spawns) keep a strictly-increasing per-run
// event sequence. The SSE bridge filters by `monotonicId > lastSeen`;
// resetting to 0 on every spawn would silently drop every event from
// the second and later sessions.
async function tailMaxMonotonicId(path: string): Promise<number> {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;

  try {
    handle = await openFile(path, "r");
    const stat = await handle.stat();
    const size = stat.size;

    if (size === 0) return 0;
    const readBytes = Math.min(size, TAIL_SCAN_BYTES);
    const buf = new Uint8Array(readBytes);

    await handle.read(buf, 0, readBytes, size - readBytes);
    const text = new TextDecoder().decode(buf);
    const lines = text.split("\n").filter((l) => l.length > 0);
    let highest = 0;

    // Walk lines back-to-front. The first line may be partial because
    // the read window did not start on a record boundary, so skip it
    // unless we read the whole file. Subsequent lines are always
    // complete records.
    const startIndex = readBytes < size && lines.length > 1 ? 1 : 0;

    for (let i = startIndex; i < lines.length; i += 1) {
      try {
        const ev = JSON.parse(lines[i]) as { monotonicId?: unknown };

        if (typeof ev.monotonicId === "number" && ev.monotonicId > highest) {
          highest = ev.monotonicId;
        }
      } catch {
        /* skip malformed line — won't affect correctness, just lower bound */
      }
    }

    return highest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore close error */
      }
    }
  }
}

export type SpawnSessionOptions = {
  sessionId: string;
  request: StartSessionRequest;
  // ADR-164: every run-dir path and the cwd come from the resolved workspace
  // (the adopted handle) — the single path-derivation site.
  workspace: WorkspaceResolution;
  runtimeRoot: string;
  logger: Logger;
  binaryOverride?: string;
  preArgs?: string[];
};

export type SpawnSessionResult = {
  child: ChildProcess;
  emitter: EventEmitter;
  record: SessionRecord;
  logPath: string;
  logStream: WriteStream;
  acpStdoutTap: PassThrough;
  eventsLog: EventsLogWriter;
  eventsLogPath: string;
};

// The request fields the child environment is layered from. The model-catalog
// probe and the adapter smoke build one without a session, so the parameter is
// the subset rather than a full StartSessionRequest.
export type ChildEnvRequest = Pick<
  StartSessionRequest,
  "executor" | "capabilityProfilePath" | "adapterLaunch"
>;

export function buildChildEnv(
  request: ChildEnvRequest,
  opts: { contextMounts?: ContextMount[] } = {},
): NodeJS.ProcessEnv {
  // ADR-164: mounts come from the resolved workspace (the adopted handle) —
  // the request body never carries a path.
  const contextMounts = opts.contextMounts;

  return {
    ...process.env,
    ...(request.executor.env ?? {}),
    ...(request.capabilityProfilePath
      ? { MAISTER_CAPABILITY_PROFILE_PATH: request.capabilityProfilePath }
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
    ...(request.adapterLaunch?.env ?? {}),
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

  // ADR-164: the step log and the per-RUN events log (shared by every session
  // of the run so the web SSE bridge tails one file) both come from the
  // resolved workspace — the single path-derivation site.
  const { logPath, eventsLogPath } = workspace;

  await mkdir(dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });
  // Seed monotonicId from the tail of the durable per-run log so the
  // event sequence stays strictly increasing across consecutive
  // sessions of the same run.
  const seedMonotonicId = await tailMaxMonotonicId(eventsLogPath);
  // M42 (ADR-114): a single-session run omits sessionName → "default".
  const sessionName = request.sessionName ?? "default";
  const eventsLog = await openEventsLog(eventsLogPath, {
    logger,
    sessionName,
    nodeAttemptId: request.nodeAttemptId,
  });

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
      executionWorkspaceId: workspace.executionWorkspaceId ?? null,
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
      hasCapabilityProfile: Boolean(request.capabilityProfilePath),
      eventsLogPath,
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
      void eventsLog.close();
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
    await eventsLog.close();
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
    eventsLog,
    eventsLogPath,
  };
}
