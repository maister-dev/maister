import type { Logger } from "pino";

import { SupervisorError } from "./types";

export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type PermissionDeferred = {
  resolve: (outcome: AcpPermissionOutcome) => void;
  reject: (err: Error) => void;
};

// ADR-180: the registry has no access to the child process, so the
// teardown a cap must perform is INSTALLED rather than imported. The
// production registry is a module-level singleton created at import, so the
// installer must also arm requests registered before it was called.
export type CapHandler = (sessionId: string, requestId: string) => void;

export type PendingPermissionRegistry = {
  setCapHandler(handler: CapHandler): void;
  register(
    sessionId: string,
    requestId: string,
    deferred: PermissionDeferred,
  ): void;
  resolve(sessionId: string, requestId: string, optionId: string): boolean;
  cancel(sessionId: string, requestId: string, reason: string): boolean;
  reject(sessionId: string, requestId: string, error: Error): boolean;
  size(sessionId?: string): number;
  totalSize(): number;
  // M8 T4: enumerate currently-open requestIds for a session so the
  // checkpoint endpoint can cancel them all in lockstep before SIGTERM.
  requestIds(sessionId: string): string[];
  purgeSession(sessionId: string): void;
};

type Entry = {
  deferred: PermissionDeferred;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
};

export type CreatePendingPermissionsOptions = {
  logger?: Logger;
  timeoutMs?: number;
  onCapExceeded?: CapHandler;
};

export const DEFAULT_PERMISSION_MAX_HOURS = 24;

// Parsed as a positive FLOAT, unlike its `positiveIntFromEnv` neighbours. The
// deviation is load-bearing: the integration lane drives the cap with
// sub-second values, and an integer-only parser would make 1 hour the smallest
// expressible cap and leave the timer path entirely unpinned.
export function permissionMaxHoursEnv(logger?: Logger): number {
  const raw = process.env.MAISTER_PERMISSION_MAX_HOURS;

  if (raw === undefined || raw === "") return DEFAULT_PERMISSION_MAX_HOURS;

  const parsed = Number.parseFloat(raw);

  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  logger?.warn(
    { raw, fallbackHours: DEFAULT_PERMISSION_MAX_HOURS },
    "MAISTER_PERMISSION_MAX_HOURS is not a positive number — using the default",
  );

  return DEFAULT_PERMISSION_MAX_HOURS;
}

export function createPendingPermissions(
  opts: CreatePendingPermissionsOptions = {},
): PendingPermissionRegistry {
  const log = opts.logger?.child({ name: "supervisor-acp" });
  const timeoutMs =
    opts.timeoutMs ?? permissionMaxHoursEnv(opts.logger) * 3_600_000;
  const sessions = new Map<string, Map<string, Entry>>();
  let capHandler: CapHandler | undefined = opts.onCapExceeded;

  const evict = (sessionId: string, requestId: string): Entry | undefined => {
    const bySession = sessions.get(sessionId);
    const entry = bySession?.get(requestId);

    if (!entry || !bySession) return undefined;

    bySession.delete(requestId);
    if (bySession.size === 0) sessions.delete(sessionId);
    clearTimeout(entry.timer);

    return entry;
  };

  const api: PendingPermissionRegistry = {
    setCapHandler(handler): void {
      capHandler = handler;
    },

    register(sessionId, requestId, deferred): void {
      let bySession = sessions.get(sessionId);

      if (!bySession) {
        bySession = new Map();
        sessions.set(sessionId, bySession);
      }

      const existing = bySession.get(requestId);

      if (existing) {
        log?.warn(
          { sessionId, requestId },
          "pending-permission register collision; overwriting",
        );
        clearTimeout(existing.timer);
        existing.deferred.reject(
          new SupervisorError(
            "CRASH",
            `pending permission ${requestId} overwritten`,
          ),
        );
      }

      const timer = setTimeout(() => {
        const entry = sessions.get(sessionId)?.get(requestId);

        if (!entry) return;
        log?.warn(
          {
            sessionId,
            requestId,
            timeoutMs,
            ageMs: Date.now() - entry.createdAt,
          },
          "pending-permission cap exceeded",
        );
        if (capHandler) {
          capHandler(sessionId, requestId);

          return;
        }
        // No teardown installed (a harness that never called setCapHandler):
        // release the deferred as CANCELLED rather than leak it. The cap NEVER
        // rejects — a rejected permission is a producer fault that reaches
        // abortOutput and SIGKILLs the child.
        api.cancel(sessionId, requestId, "permission_cap");
      }, timeoutMs);

      timer.unref?.();

      bySession.set(requestId, {
        deferred,
        timer,
        createdAt: Date.now(),
      });

      log?.debug(
        { sessionId, requestId, timeoutMs },
        "pending-permission registered",
      );
    },

    resolve(sessionId, requestId, optionId): boolean {
      const entry = evict(sessionId, requestId);

      if (!entry) return false;

      log?.info(
        {
          sessionId,
          requestId,
          optionId,
          ageMs: Date.now() - entry.createdAt,
        },
        "pending-permission resolved",
      );
      entry.deferred.resolve({ outcome: "selected", optionId });

      return true;
    },

    cancel(sessionId, requestId, reason): boolean {
      const entry = evict(sessionId, requestId);

      if (!entry) return false;

      log?.info(
        {
          sessionId,
          requestId,
          reason,
          ageMs: Date.now() - entry.createdAt,
        },
        "pending-permission cancelled",
      );
      entry.deferred.resolve({ outcome: "cancelled" });

      return true;
    },

    reject(sessionId, requestId, error): boolean {
      const entry = evict(sessionId, requestId);

      if (!entry) return false;

      log?.warn(
        {
          sessionId,
          requestId,
          err: error.message,
          ageMs: Date.now() - entry.createdAt,
        },
        "pending-permission rejected",
      );
      entry.deferred.reject(error);

      return true;
    },

    size(sessionId?: string): number {
      if (sessionId === undefined) {
        let total = 0;

        for (const bySession of sessions.values()) total += bySession.size;

        return total;
      }

      return sessions.get(sessionId)?.size ?? 0;
    },

    totalSize(): number {
      let total = 0;

      for (const bySession of sessions.values()) total += bySession.size;

      return total;
    },

    requestIds(sessionId): string[] {
      const bySession = sessions.get(sessionId);

      return bySession ? Array.from(bySession.keys()) : [];
    },

    purgeSession(sessionId): void {
      const bySession = sessions.get(sessionId);

      if (!bySession) return;

      const ids = Array.from(bySession.keys());
      const purgeError = new SupervisorError("CRASH", "session terminated");

      for (const requestId of ids) {
        const entry = bySession.get(requestId);

        if (!entry) continue;
        clearTimeout(entry.timer);
        log?.warn(
          {
            sessionId,
            requestId,
            ageMs: Date.now() - entry.createdAt,
          },
          "pending-permission purged on session terminate",
        );
        entry.deferred.reject(purgeError);
      }

      sessions.delete(sessionId);
    },
  };

  return api;
}

export const pendingPermissions: PendingPermissionRegistry =
  createPendingPermissions();
