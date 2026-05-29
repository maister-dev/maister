import type { Logger } from "pino";

import { SupervisorError } from "./types";

export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type PermissionDeferred = {
  resolve: (outcome: AcpPermissionOutcome) => void;
  reject: (err: Error) => void;
};

export type PendingPermissionRegistry = {
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
};

export function keepaliveMinutesEnv(): number {
  const raw = process.env.MAISTER_KEEPALIVE_MINUTES ?? "30";
  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export function createPendingPermissions(
  opts: CreatePendingPermissionsOptions = {},
): PendingPermissionRegistry {
  const log = opts.logger?.child({ name: "supervisor-acp" });
  const timeoutMs = opts.timeoutMs ?? keepaliveMinutesEnv() * 60_000;
  const sessions = new Map<string, Map<string, Entry>>();

  const evict = (sessionId: string, requestId: string): Entry | undefined => {
    const bySession = sessions.get(sessionId);
    const entry = bySession?.get(requestId);

    if (!entry || !bySession) return undefined;

    bySession.delete(requestId);
    if (bySession.size === 0) sessions.delete(sessionId);
    clearTimeout(entry.timer);

    return entry;
  };

  return {
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
        const evicted = evict(sessionId, requestId);

        if (!evicted) return;
        log?.warn(
          {
            sessionId,
            requestId,
            timeoutMs,
            ageMs: Date.now() - evicted.createdAt,
          },
          "pending-permission timed out",
        );
        evicted.deferred.reject(
          new SupervisorError(
            "HITL_TIMEOUT",
            `permission request ${requestId} timed out after ${Math.floor(timeoutMs / 60_000)} minutes`,
          ),
        );
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
}

export const pendingPermissions: PendingPermissionRegistry =
  createPendingPermissions();
