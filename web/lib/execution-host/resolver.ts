import type { Db } from "./db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type { ExecutionHostTransport } from "./contracts";
import type { RegistrationResult } from "./registrar";

import { is } from "drizzle-orm";
import { NodePgTransaction } from "drizzle-orm/node-postgres";
import pino, { type Logger } from "pino";

import { getLatestAssignment } from "./assignments";
import { findActiveLocalHost, getHostById } from "./hosts";
import { ensureAdditionalExecutionDataPlane, ensureLocalExecutionDataPlane } from "./event-plane";
import { ensureAdditionalExecutionHost, ensureLocalExecutionHost } from "./registrar";
import { configuredAdditionalExecutionEndpoints, configuredExecutionEndpointForHost, configuredSelectedExecutionEndpoint } from "./selected-endpoint";
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

export function primeResolverForTests(host: ExecutionHost): void {
  state.memo = { host, observedAt: Number.POSITIVE_INFINITY };
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

// ADR-166 D1 "web resolution": the registered local host, memoized 30 s
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
  // A transaction may read a registration. Observe the process and start
  // ingestion only on a pooled connection outside the claim.
  if (is(opts.db, NodePgTransaction)) {
    const host = await findActiveLocalHost(opts.db);

    if (!host || host.readiness !== "ready")
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "No ready local execution host is registered for the claim",
        { details: { reason: "execution_host_unregistered_for_claim" } },
      );

    return host;
  }
  if (state.inflight) return state.inflight;

  state.inflight = (async () => {
    const result = await ensureLocalExecutionDataPlane({
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
    `assignment ${args.assignmentId} belongs to execution host ${args.assignmentHostKey}, whose identity is no longer current`,
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

/** Re-attest the stored host chosen for new work before minting its assignment. */
export async function hostForSelection(
  db: Db,
  hostId: string,
  opts: Omit<ResolveHostOptions, "db" | "force"> = {},
): Promise<ExecutionHost> {
  const host = await getHostById(db, hostId);
  if (!host || host.retiredAt || !configuredExecutionEndpointForHost(host.hostKey))
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "The selected execution host is no longer configured", {
      details: { reason: HOST_IDENTITY_MISMATCH_REASON, hostId },
    });
  const peer = configuredAdditionalExecutionEndpoints().find((endpoint) => endpoint.hostKey === host.hostKey);
  const transactional = is(db, NodePgTransaction);
  const result = peer
    ? await (transactional ? ensureAdditionalExecutionHost : ensureAdditionalExecutionDataPlane)(
        peer, { db, now: opts.now, logger: opts.logger },
      )
    : await (transactional ? ensureLocalExecutionHost : ensureLocalExecutionDataPlane)({ ...opts, db });
  if (result.status !== "registered") throw hostUnavailableError(result);
  if (result.host.id !== host.id)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "The selected execution host changed identity", {
      details: { reason: HOST_IDENTITY_MISMATCH_REASON, hostId },
    });
  return result.host;
}

// ADR-166 X-EH-02: the host an assignment was placed on, verified against the
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

  if (host.transport.role === "secondary") {
    const peer = configuredAdditionalExecutionEndpoints().find((candidate) => candidate.hostKey === host.hostKey);
    if (!peer)
      throw hostIdentityMismatchError({
        assignmentId: assignment.id, assignmentHostKey: host.hostKey, observedHostKey: null,
      });
    const result = await ensureAdditionalExecutionHost(peer, {
      db, now: opts.now, logger: opts.logger,
    });
    if (result.status !== "registered") throw hostUnavailableError(result);
    if (result.host.id !== host.id)
      throw hostIdentityMismatchError({
        assignmentId: assignment.id, assignmentHostKey: host.hostKey, observedHostKey: result.host.hostKey,
      });
    return result.host;
  }

  const selected = configuredSelectedExecutionEndpoint();

  if (selected) {
    if (selected.hostKey !== host.hostKey) {
      throw hostIdentityMismatchError({
        assignmentId: assignment.id,
        assignmentHostKey: host.hostKey,
        observedHostKey: selected.hostKey,
      });
    }

    // A memoized readiness check cannot attest the peer receiving a command
    // or a receipt read. A restart updates the stored boot on the same row.
    const observed = await ensureLocalExecutionHost({ ...opts, db });

    if (observed.status !== "registered") throw hostUnavailableError(observed);
    if (observed.host.id !== host.id) {
      throw hostIdentityMismatchError({
        assignmentId: assignment.id,
        assignmentHostKey: host.hostKey,
        observedHostKey: observed.host.hostKey,
      });
    }

    return observed.host;
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

/** Resolve a resume or return on its previous host before locking the Run. */
export async function resolveRunPlacementHost(
  db: Db,
  runId: string,
  opts: Pick<ResolveHostOptions, "transport" | "logger"> = {},
): Promise<ExecutionHost> {
  const previous = await getLatestAssignment(db, runId);

  return previous
    ? hostForAssignment(db, previous, opts)
    : localHost({ ...opts, db });
}
