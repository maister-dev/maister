import type { RegistryEntry, SessionRegistry } from "./registry";
import type { Logger } from "pino";

import { pendingPermissions } from "./pending-permissions";
import { terminateSessionProcess } from "./execution-fence";
import { SupervisorError } from "./types";

async function stopSession(
  entry: RegistryEntry,
  registry: SessionRegistry,
  logger: Logger,
  graceMs: number,
): Promise<void> {
  const { record, child } = entry;

  // ADR-180: order first, and CANCEL rather than purge. `purgeSession`
  // REJECTS every open deferred, which reaches abortOutput and SIGKILLs the
  // child the supervisor is in the middle of asking to exit politely. A
  // cancel is journalled by the adapter and replayed after session/resume.
  if (child.exitCode === null && child.signalCode === null) {
    registry.markIntentionalShutdown(record.sessionId);
    for (const requestId of pendingPermissions.requestIds(record.sessionId)) {
      pendingPermissions.cancel(record.sessionId, requestId, "shutdown");
    }
  }
  const termination = await terminateSessionProcess(entry, graceMs, logger);

  if (termination !== "confirmed")
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "Supervisor shutdown could not confirm its owned process group retirement",
      {
        details: {
          reason: "session_process_owner_unconfirmed",
          runId: record.runId,
          sessionId: record.sessionId,
          stage: termination,
        },
      },
    );
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
