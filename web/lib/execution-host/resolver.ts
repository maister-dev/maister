import type { Db } from "./db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type { ExecutionHostTransport } from "./contracts";
import type { RegistrationResult } from "./registrar";

import pino, { type Logger } from "pino";

import { getHostById } from "./hosts";
import { ensureLocalExecutionHost } from "./registrar";
import { HOST_IDENTITY_MISMATCH_REASON } from "./types";

import { MaisterError } from "@/lib/errors";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "resolver" });

export const HOST_MEMO_TTL_MS = 30_000;

type ResolverState = {
  memo: { host: ExecutionHost; observedAt: number } | null;
  inflight: Promise<ExecutionHost> | null;
};

declare global {
  var __maisterHostResolverState: ResolverState | undefined;
}

const state: ResolverState = globalThis.__maisterHostResolverState ?? {
  memo: null,
  inflight: null,
};

globalThis.__maisterHostResolverState = state;

export function resetResolverForTests(): void {
  state.memo = null;
  state.inflight = null;
}

export type ResolveHostOptions = {
  db?: Db;
  transport?: ExecutionHostTransport;
  now?: () => Date;
  force?: boolean;
  logger?: Logger;
};

export function hostUnavailableError(result: RegistrationResult): MaisterError {
  if (result.status === "refused") {
    return new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `the local execution host changed identity while host ${result.host.hostKey} still owns live runs`,
      {
        details: {
          reason: HOST_IDENTITY_MISMATCH_REASON,
          hostKey: result.host.hostKey,
          liveRunIds: result.liveRunIds,
        },
      },
    );
  }
  if (result.status === "unavailable") {
    return new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `local execution host unavailable (${result.reason}): ${result.message}`,
      { details: { reason: result.reason } },
    );
  }

  /* istanbul ignore next -- registered results never reach here */
  return new MaisterError("EXECUTOR_UNAVAILABLE", "host resolution failed");
}

// ADR-164 D1 "web resolution": the registered local host, memoized 30 s
// (one health call per window, single-flight under concurrency). Throws
// EXECUTOR_UNAVAILABLE when the host is unreachable or refused — the launch
// path's existing 503.
export async function localHost(
  opts: ResolveHostOptions = {},
): Promise<ExecutionHost> {
  const now = opts.now ?? (() => new Date());
  const at = now().getTime();

  if (
    !opts.force &&
    state.memo &&
    at - state.memo.observedAt < HOST_MEMO_TTL_MS
  ) {
    return state.memo.host;
  }
  if (state.inflight) return state.inflight;

  state.inflight = (async () => {
    const result = await ensureLocalExecutionHost({
      db: opts.db,
      transport: opts.transport,
      now,
      logger: opts.logger ?? defaultLog,
    });

    if (result.status !== "registered") throw hostUnavailableError(result);
    state.memo = { host: result.host, observedAt: now().getTime() };

    return result.host;
  })().finally(() => {
    state.inflight = null;
  });

  return state.inflight;
}

export function hostIdentityMismatchError(args: {
  assignmentId: string;
  assignmentHostKey: string;
  observedHostKey: string | null;
}): MaisterError {
  return new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    `assignment ${args.assignmentId} belongs to execution host ${args.assignmentHostKey}, which is no longer the local host`,
    {
      details: {
        reason: HOST_IDENTITY_MISMATCH_REASON,
        assignmentId: args.assignmentId,
        assignmentHostKey: args.assignmentHostKey,
        observedHostKey: args.observedHostKey,
      },
    },
  );
}

// ADR-164 X-EH-02: the host an assignment was placed on, verified against the
// host the registrar last observed. A retired row, a row refused for
// `identity_changed`, or a key that differs from the live local host all
// surface as `EXECUTOR_UNAVAILABLE {reason:"host_identity_mismatch"}`.
export async function hostForAssignment(
  db: Db,
  assignment: Pick<ExecutionAssignment, "id" | "executionHostId">,
  opts: Omit<ResolveHostOptions, "db" | "force"> = {},
): Promise<ExecutionHost> {
  const host = await getHostById(db, assignment.executionHostId);

  if (!host) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `assignment ${assignment.id} references an unknown execution host`,
      { details: { reason: "host_missing", assignmentId: assignment.id } },
    );
  }
  if (
    host.retiredAt ||
    (host.readiness === "unavailable" &&
      host.readinessReason === "identity_changed")
  ) {
    throw hostIdentityMismatchError({
      assignmentId: assignment.id,
      assignmentHostKey: host.hostKey,
      observedHostKey: null,
    });
  }

  let live: ExecutionHost | null = null;

  try {
    live = await localHost({ ...opts, db });
  } catch (err) {
    // An unreachable host is the deliverer's problem (unknown-outcome retry →
    // EXECUTOR_UNAVAILABLE); only a DIFFERENT identity is a mismatch.
    if (
      err instanceof MaisterError &&
      err.details?.reason === HOST_IDENTITY_MISMATCH_REASON
    ) {
      throw hostIdentityMismatchError({
        assignmentId: assignment.id,
        assignmentHostKey: host.hostKey,
        observedHostKey: null,
      });
    }
  }
  if (live && live.hostKey !== host.hostKey) {
    throw hostIdentityMismatchError({
      assignmentId: assignment.id,
      assignmentHostKey: host.hostKey,
      observedHostKey: live.hostKey,
    });
  }

  return host;
}
