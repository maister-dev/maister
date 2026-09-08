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

    pendingPermissions.purgeSession(record.sessionId);
    registry.markIntentionalShutdown(record.sessionId);
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
