import type { Db } from "./db";
import type { ExecutionHost } from "@/lib/db/schema";
import type { ExecutionHostTransport } from "./contracts";
import type { HostCapabilities } from "./hosts";

import pino, { type Logger } from "pino";

import {
  countLiveAssignmentsForHost,
  findActiveLocalHost,
  insertLocalHost,
  listLiveRunIdsForHost,
  lockActiveLocalHost,
  markHostReadiness,
  retireHost,
  touchLocalHost,
} from "./hosts";
import { defaultTransport } from "./default-transport";

import { getDb } from "@/lib/db/client";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "registrar" });

export type ObservedHost = {
  hostKey: string;
  bootId: string;
  capabilities: HostCapabilities;
};

export type RegistrationAction =
  | "insert"
  | "touch"
  | "restart"
  | "retire_and_insert"
  | "refuse";

export type RegistrationObservation = {
  activeRow: Pick<ExecutionHost, "hostKey" | "lastBootId"> | null;
  observed: Pick<ObservedHost, "hostKey" | "bootId">;
  liveAssignments: number;
};

// ADR-166 D1 identity-change policy as DATA — first matching row wins. The
// registrar applies the action under a `SELECT … FOR UPDATE` of the active
// local row (lock → verify → commit), so two web processes cannot both insert.
export const REGISTRATION_POLICY: ReadonlyArray<{
  readonly when: (o: RegistrationObservation) => boolean;
  readonly action: RegistrationAction;
}> = [
  { when: (o) => o.activeRow === null, action: "insert" },
  {
    when: (o) =>
      o.activeRow?.hostKey === o.observed.hostKey &&
      o.activeRow.lastBootId === o.observed.bootId,
    action: "touch",
  },
  {
    when: (o) => o.activeRow?.hostKey === o.observed.hostKey,
    action: "restart",
  },
  { when: (o) => o.liveAssignments === 0, action: "retire_and_insert" },
  { when: () => true, action: "refuse" },
];

export function decideRegistration(
  observation: RegistrationObservation,
): RegistrationAction {
  for (const rule of REGISTRATION_POLICY) {
    if (rule.when(observation)) return rule.action;
  }

  /* istanbul ignore next -- the last rule always matches */
  return "refuse";
}

export type RegistrationResult =
  | {
      status: "registered";
      host: ExecutionHost;
      action: Exclude<RegistrationAction, "refuse">;
      restarted: boolean;
    }
  | { status: "refused"; host: ExecutionHost; liveRunIds: string[] }
  | {
      status: "unavailable";
      reason: string;
      message: string;
      host: ExecutionHost | null;
    };

export const UNAVAILABLE_MARK_INTERVAL_MS = 30_000;

type RegistrarState = {
  unavailableMarkedAt: Map<string, number>;
  reconciledBootId: string | null;
};

declare global {
  var __maisterRegistrarState: RegistrarState | undefined;
}

// HMR-safe process state (mirrors the sweeper handles on globalThis).
const state: RegistrarState = globalThis.__maisterRegistrarState ?? {
  unavailableMarkedAt: new Map(),
  reconciledBootId: null,
};

globalThis.__maisterRegistrarState = state;

export function resetRegistrarStateForTests(): void {
  state.unavailableMarkedAt.clear();
  state.reconciledBootId = null;
}

export type EnsureLocalHostOptions = {
  db?: Db;
  transport?: ExecutionHostTransport;
  now?: () => Date;
  onRestart?: () => Promise<void>;
  logger?: Logger;
  healthTimeoutMs?: number;
};

async function defaultOnRestart(): Promise<void> {
  const { runReconcileSweep } = await import("@/lib/reconcile");

  await runReconcileSweep();
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

async function markUnavailable(
  db: Db,
  reason: string,
  message: string,
  now: Date,
  logger: Logger,
): Promise<RegistrationResult> {
  const row = await findActiveLocalHost(db);

  if (row) {
    const last = state.unavailableMarkedAt.get(row.id);

    // At most one readiness write per 30 s window (D1) — a down supervisor
    // must not turn every launch attempt into an UPDATE.
    if (
      last === undefined ||
      now.getTime() - last >= UNAVAILABLE_MARK_INTERVAL_MS
    ) {
      await markHostReadiness(db, row.id, "unavailable", reason, now);
      state.unavailableMarkedAt.set(row.id, now.getTime());
      logger.warn(
        { hostKey: row.hostKey, hostId: row.id, reason, message },
        "execution-host-unavailable",
      );
    }
  }

  return { status: "unavailable", reason, message, host: row };
}

// ADR-166 D1: observe `GET /health`, then apply the identity-change policy
// under the active row's lock. Never throws on an unreachable or refused
// host — launches keep today's 503 through the resolver instead.
export async function ensureLocalExecutionHost(
  opts: EnsureLocalHostOptions = {},
): Promise<RegistrationResult> {
  const db = opts.db ?? getDb();
  const transport = opts.transport ?? defaultTransport();
  const logger = opts.logger ?? defaultLog;
  const now = opts.now ?? (() => new Date());
  const health = await transport.health({
    timeoutMs: opts.healthTimeoutMs,
  });

  if (health.kind !== "ready") {
    return markUnavailable(db, health.reason, health.message, now(), logger);
  }
  if (!health.identity) {
    return markUnavailable(
      db,
      "no_identity",
      "supervisor /health carries no execution-host identity (pre-ADR-166 supervisor)",
      now(),
      logger,
    );
  }

  const observed: ObservedHost = {
    hostKey: health.identity.hostKey,
    bootId: health.identity.bootId,
    capabilities: {
      protocolVersion: health.identity.protocolVersion,
      supervisorVersion: health.version,
      adapters: [],
    },
  };

  const apply = async (): Promise<RegistrationResult> =>
    db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const activeRow = await lockActiveLocalHost(txDb);
      const liveAssignments = activeRow
        ? await countLiveAssignmentsForHost(txDb, activeRow.id)
        : 0;
      const action = decideRegistration({
        activeRow,
        observed,
        liveAssignments,
      });
      const at = now();

      switch (action) {
        case "insert": {
          const host = await insertLocalHost(txDb, {
            hostKey: observed.hostKey,
            bootId: observed.bootId,
            capabilities: observed.capabilities,
            now: at,
            logger,
          });

          logger.info(
            { hostKey: host.hostKey, hostId: host.id, bootId: observed.bootId },
            "execution-host-registered",
          );

          return { status: "registered", host, action, restarted: false };
        }
        case "touch":
        case "restart": {
          const previousBootId = activeRow!.lastBootId;
          const host = (await touchLocalHost(txDb, activeRow!.id, {
            bootId: observed.bootId,
            capabilities: observed.capabilities,
            now: at,
          }))!;

          if (action === "restart") {
            logger.info(
              {
                hostKey: host.hostKey,
                hostId: host.id,
                previousBootId,
                bootId: observed.bootId,
              },
              "execution-host-restarted",
            );
          }

          return {
            status: "registered",
            host,
            action,
            restarted: action === "restart",
          };
        }
        case "retire_and_insert": {
          await retireHost(txDb, activeRow!.id, at, logger);
          const host = await insertLocalHost(txDb, {
            hostKey: observed.hostKey,
            bootId: observed.bootId,
            capabilities: observed.capabilities,
            now: at,
            logger,
          });

          logger.info(
            {
              hostKey: host.hostKey,
              hostId: host.id,
              retiredHostKey: activeRow!.hostKey,
            },
            "execution-host-registered",
          );

          return { status: "registered", host, action, restarted: false };
        }
        case "refuse": {
          const liveRunIds = await listLiveRunIdsForHost(txDb, activeRow!.id);

          await markHostReadiness(
            txDb,
            activeRow!.id,
            "unavailable",
            "identity_changed",
            at,
          );
          logger.error(
            {
              storedHostKey: activeRow!.hostKey,
              observedHostKey: observed.hostKey,
              liveAssignments,
              liveRunIds,
              remediation:
                "pin the stored key on the new supervisor (MAISTER_EXECUTION_HOST_KEY), or stop/abandon the listed runs before switching hosts",
            },
            "execution-host-identity-mismatch",
          );

          return { status: "refused", host: activeRow!, liveRunIds };
        }
      }
    });

  let result: RegistrationResult;

  try {
    result = await apply();
  } catch (err) {
    // Two web processes raced the partial unique index: the loser re-reads
    // and lands on `touch`/`restart` against the winner's row.
    if (!isUniqueViolation(err)) throw err;
    result = await apply();
  }

  if (result.status === "registered") {
    state.unavailableMarkedAt.delete(result.host.id);

    if (result.restarted && state.reconciledBootId !== observed.bootId) {
      state.reconciledBootId = observed.bootId;

      try {
        await (opts.onRestart ?? defaultOnRestart)();
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "execution-host-restart-reconcile-failed",
        );
      }
    }
  }

  return result;
}
