import type { RegistryEntry, SessionRegistry } from "./registry";
import type { Logger } from "pino";

import { pendingPermissions } from "./pending-permissions";

async function stopSession(
  entry: RegistryEntry,
  registry: SessionRegistry,
  logger: Logger,
  graceMs: number,
): Promise<void> {
  const { child, record } = entry;
  const hasExited = (): boolean =>
    child.exitCode !== null || child.signalCode !== null;

  if (!hasExited()) {
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );

    // ADR-180: order first, and CANCEL rather than purge. `purgeSession`
    // REJECTS every open deferred, which reaches abortOutput and SIGKILLs the
    // child the supervisor is in the middle of asking to exit politely. A
    // cancel is journalled by the adapter and replayed after session/resume.
    registry.markIntentionalShutdown(record.sessionId);
    for (const requestId of pendingPermissions.requestIds(record.sessionId)) {
      pendingPermissions.cancel(record.sessionId, requestId, "shutdown");
    }
    record.stopOutputForTeardown?.();
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (hasExited()) return;
      logger.warn({ sessionId: record.sessionId }, "shutdown-sigkill");
      child.kill("SIGKILL");
    }, graceMs);

    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  // Process death precedes pipe drain and the durable terminal append.
  await record.outputDrained;
  await record.outputTerminal;
}

export async function stopRegisteredSessions(
  registry: SessionRegistry,
  logger: Logger,
  graceMs: number,
): Promise<void> {
  const entries: RegistryEntry[] = [];

  registry.forEach((entry) => entries.push(entry));
  await Promise.all(
    entries.map((entry) => stopSession(entry, registry, logger, graceMs)),
  );
}
