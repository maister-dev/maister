import type { PendingPermissionRegistry } from "./pending-permissions";
import type { RegistryEntry, SessionRegistry } from "./registry";
import type { Logger } from "pino";

import { waitForChildExit } from "./execution-fence";
import { SupervisorError } from "./types";

export type CheckpointCause = "permission_cap";

export type CheckpointSessionInput = {
  entry: RegistryEntry;
  registry: SessionRegistry;
  // Injected, never imported: this module owns teardown, `pending-permissions`
  // owns deferred lifetime, and neither learns the other's internals.
  permissions: PendingPermissionRegistry;
  logger: Logger;
  killGraceMs: number;
  // Diagnostic only (ADR-180 D6): it rides the emitted `session.exited`
  // payload and nothing branches on it.
  cause?: CheckpointCause;
};

export type CheckpointSessionResult = {
  alreadyCheckpointed: boolean;
  monotonicId: number;
  pendingPermissionCount: number;
};

/** Park a session and keep its ACP handle resumable.
 *
 * Shared verbatim by `POST /sessions/:id/checkpoint` and by the host's own
 * absolute permission cap (ADR-180). The route wraps it in the ADR-166 command
 * envelope; the cap has none. The two teardowns in `http-api.ts` for DELETE and
 * cancel are NOT folded in — they answer different questions with different
 * post-conditions.
 */
export async function checkpointSession(
  input: CheckpointSessionInput,
): Promise<CheckpointSessionResult> {
  const { entry, registry, permissions, killGraceMs, cause } = input;
  const sessionId = entry.record.sessionId;
  const log = input.logger.child({ name: "supervisor-checkpoint" });
  const startedAt = Date.now();

  if (entry.record.status === "exited" || entry.record.status === "crashed") {
    log.info(
      { sessionId, status: entry.record.status, alreadyCheckpointed: true },
      "checkpoint endpoint idempotent ack",
    );

    return {
      alreadyCheckpointed: true,
      monotonicId: entry.record.monotonicId,
      pendingPermissionCount: 0,
    };
  }

  const requestIds = permissions.requestIds(sessionId);

  log.info(
    { sessionId, pendingPermissionCount: requestIds.length, cause },
    "checkpoint requested",
  );

  for (const requestId of requestIds) {
    permissions.cancel(sessionId, requestId, "checkpoint");
  }

  registry.markIntentionalShutdown(sessionId, "checkpoint", cause);
  entry.record.stopOutputForTeardown?.();
  entry.child.kill("SIGTERM");

  const exited = await waitForChildExit(entry, killGraceMs);

  if (!exited) {
    log.warn(
      { sessionId, killGraceMs },
      "checkpoint sigterm-grace-expired-sigkill",
    );
    entry.child.kill("SIGKILL");

    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      `checkpoint timed out — SIGKILL escalation after ${killGraceMs}ms`,
    );
  }

  log.info(
    {
      sessionId,
      latencyMs: Date.now() - startedAt,
      pendingPermissionCount: requestIds.length,
      alreadyCheckpointed: false,
      cause,
    },
    "checkpoint complete",
  );

  return {
    alreadyCheckpointed: false,
    monotonicId: entry.record.monotonicId,
    pendingPermissionCount: requestIds.length,
  };
}

/** Install the host's absolute-permission-cap teardown.
 *
 * ADR-180 D10: the cap timer knows a `(sessionId, requestId)` and nothing else
 * — the registry that owns the child process is not in its scope. Both boot
 * paths (production `main.ts` and the in-process test harness) MUST call this;
 * a registration checklist nothing executes is an unverified claim, so the
 * wiring lives in one function rather than in two hand-copied closures.
 */
export function installPermissionCapTeardown(deps: {
  registry: SessionRegistry;
  permissions: PendingPermissionRegistry;
  logger: Logger;
  killGraceMs: number;
}): void {
  deps.permissions.setCapHandler((sessionId, requestId) => {
    const entry = deps.registry.get(sessionId);

    if (!entry) {
      deps.permissions.cancel(sessionId, requestId, "permission_cap");

      return;
    }

    void checkpointSession({
      entry,
      registry: deps.registry,
      permissions: deps.permissions,
      logger: deps.logger,
      killGraceMs: deps.killGraceMs,
      cause: "permission_cap",
    }).catch((err: unknown) => {
      // Host-internal: there is no caller to return this to, and the web
      // sweeper's own `client.checkpoint` is the retry.
      deps.logger.error(
        {
          sessionId,
          requestId,
          err: err instanceof Error ? err.message : String(err),
        },
        "checkpoint-cap-escalated",
      );
    });
  });
}
