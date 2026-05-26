import type { Logger } from "pino";

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { SESSION_EVENT_CHANNEL } from "./registry";
import {
  SupervisorError,
  type ExecutorAgent,
  type SessionEvent,
  type SessionRecord,
  type StartSessionRequest,
} from "./types";

const BINARY_BY_AGENT: Record<ExecutorAgent, string> = {
  claude: "claude-agent-acp",
  codex: "codex-acp",
};

const MAX_LINE_BYTES = 1024 * 1024;

export type SpawnSessionOptions = {
  sessionId: string;
  request: StartSessionRequest;
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
};

export async function spawnSession(
  opts: SpawnSessionOptions,
): Promise<SpawnSessionResult> {
  const { sessionId, request, runtimeRoot, logger } = opts;
  const binary = opts.binaryOverride ?? BINARY_BY_AGENT[request.executor.agent];

  const logPath = resolve(
    runtimeRoot,
    ".maister",
    request.projectSlug,
    "runs",
    request.runId,
    `${request.stepId}.log`,
  );

  await mkdir(dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: "a" });

  const args: string[] = opts.preArgs ? [...opts.preArgs] : [];

  if (request.resumeSessionId) {
    args.push("--resume", request.resumeSessionId);
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(request.executor.env ?? {}),
  };

  logger.info(
    {
      sessionId,
      agent: request.executor.agent,
      model: request.executor.model,
      cwd: request.worktreePath,
      resume: Boolean(request.resumeSessionId),
      router: request.executor.router ?? null,
      hasEnv: Boolean(
        request.executor.env && Object.keys(request.executor.env).length > 0,
      ),
    },
    "spawn",
  );

  const child = spawn(binary, args, {
    cwd: request.worktreePath,
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
    runId: request.runId,
    projectSlug: request.projectSlug,
    stepId: request.stepId,
    status: "live",
    pid,
    startedAt: new Date().toISOString(),
    logPath,
    monotonicId: 0,
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

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    logStream.write(chunk);
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
    logStream.end();
  });

  child.stdout?.on("error", (err) => {
    logger.warn({ sessionId, err: err.message }, "stdout-error");
  });

  return { child, emitter, record, logPath, logStream };
}
