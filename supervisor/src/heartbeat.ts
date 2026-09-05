import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import type { SessionRegistry } from "./registry";

import { SupervisorError, type SessionEvent } from "./types";

const DEFAULT_REMOVE_GRACE_MS = 30_000;

export type AttachHeartbeatOptions = {
  sessionId: string;
  child: ChildProcess;
  registry: SessionRegistry;
  logger: Logger;
  removeGraceMs?: number;
};

export function attachHeartbeat(opts: AttachHeartbeatOptions): void {
  const { sessionId, child, registry, logger } = opts;
  const removeGraceMs = opts.removeGraceMs ?? DEFAULT_REMOVE_GRACE_MS;

  const emitTerminal = (event: SessionEvent) => {
    registry.emit(sessionId, event);
    const entry = registry.get(sessionId);

    if (entry) entry.record.terminalPublished = true;
    setTimeout(
      () => registry.remove(sessionId, "terminal-grace"),
      removeGraceMs,
    ).unref();
  };

  const finish = async (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> => {
    const entry = registry.get(sessionId);

    if (!entry) return;

    // Exit may arrive while the byte framer is awaiting a disk write. All
    // captured lines and their semantic updates precede this terminal event.
    await entry.record.outputDrained;
    if (entry.record.terminalPublished) return;
    const intentional = entry.intentionalShutdown;
    const cleanExit = code === 0 && signal === null;
    const treatAsExited = cleanExit || intentional;

    entry.record.exitedAt = new Date().toISOString();
    entry.record.exitCode = code;
    entry.record.signal = signal;

    entry.record.monotonicId += 1;

    if (treatAsExited) {
      logger.info(
        {
          sessionId,
          code,
          signal,
          intentional,
          reason: entry.intentionalReason,
        },
        "session-exited",
      );
      emitTerminal({
        type: "session.exited",
        sessionId,
        monotonicId: entry.record.monotonicId,
        exitCode: code ?? 0,
        ...(entry.intentionalReason ? { reason: entry.intentionalReason } : {}),
      });
    } else {
      logger.warn({ sessionId, code, signal }, "session-crashed");
      emitTerminal({
        type: "session.crashed",
        sessionId,
        monotonicId: entry.record.monotonicId,
        exitCode: code,
        signal,
      });
    }
    entry.record.status = treatAsExited ? "exited" : "crashed";
  };

  const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
    const entry = registry.get(sessionId);

    if (!entry || entry.record.outputTerminal) return;
    entry.record.outputTerminal = finish(code, signal);
    void entry.record.outputTerminal.catch((error: unknown) => {
      const failure =
        error instanceof SupervisorError
          ? error
          : new SupervisorError(
              "EXECUTOR_UNAVAILABLE",
              "session terminal evidence could not be committed",
              { details: { reason: "required_output_incomplete" } },
            );

      entry.record.abortOutput?.(failure);
      logger.error(
        { sessionId, code: failure.code, reason: failure.details?.reason },
        "session-terminal-unavailable",
      );
    });
  };

  child.once("exit", settle);
  if (child.exitCode !== null || child.signalCode !== null)
    settle(child.exitCode, child.signalCode);
  child.once("error", (error: NodeJS.ErrnoException) => {
    logger.warn({ sessionId, errno: error.code }, "session-error");
    settle(null, null);
  });
}

export type HeartbeatWatcherOptions = {
  registry: SessionRegistry;
  logger: Logger;
  intervalMs?: number;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export function startHeartbeatWatcher(
  opts: HeartbeatWatcherOptions,
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const { registry, logger } = opts;

  const tick = () => {
    const live = registry.size();

    logger.debug({ liveSessions: live }, "heartbeat-tick");

    registry.forEach((entry) => {
      if (entry.record.status !== "live") return;
      if (entry.child.killed || entry.record.outputTerminal) return;

      try {
        process.kill(entry.record.pid, 0);
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code;

        if (errno === "ESRCH") {
          entry.record.status = "crashed";
          entry.record.exitedAt = new Date().toISOString();
          entry.record.exitCode = null;
          entry.record.signal = null;
          entry.record.monotonicId += 1;
          logger.warn(
            { sessionId: entry.record.sessionId, pid: entry.record.pid },
            "session-orphaned",
          );
          registry.emit(entry.record.sessionId, {
            type: "session.crashed",
            sessionId: entry.record.sessionId,
            monotonicId: entry.record.monotonicId,
            exitCode: null,
            signal: null,
          });
          registry.remove(entry.record.sessionId, "orphan-detected");
        }
      }
    });
  };

  const handle = setInterval(tick, intervalMs);

  handle.unref();

  return () => clearInterval(handle);
}
