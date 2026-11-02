import "server-only";

import type { Db } from "./db";
import type { PreparedPromptOwner, PromptOwnerRegistry } from "./prompt-owners";
import type { SQL } from "drizzle-orm";
import type { CommandApplicationError } from "./types";
import type { ExecutionCommand } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import pino from "pino";

import { COMMAND_REQUEST_SCHEMA } from "./command-request";
import { reconcilePromptCommand } from "./prompt-reconciliation";
import {
  preparePromptOwner,
  PromptOwnerInvariantError,
  PromptOwnerDeferred,
} from "./prompt-owners";
import { PromptOwnerSchema } from "./prompt-owner-contract";
import {
  preservePromptApplicationHistory,
  promptApplicationDiagnostic,
  promptApplicationFailureSnapshot,
} from "./prompt-owner-errors";
import { projectionTransaction } from "./events/projection-transaction";
import { runEventWakeBus } from "./events/run-wake";
import { commandSignals } from "./signals";
import { TERMINAL_COMMAND_STATES } from "./types";

import { executionCommands } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { isApplicationStopping } from "@/lib/server-lifecycle";

const log = pino({
  name: "prompt-owner-application",
  level: process.env.LOG_LEVEL ?? "info",
});
const LEASE_MS = 30_000;
const RENEW_MS = 10_000;
const MAX_FAILURES = 5;

export const PROMPT_OWNER_PREPARE_TIMEOUT_MS = 120_000;

export type PromptOwnerClaim = Readonly<{
  command: ExecutionCommand;
  token: string;
}>;
export type PromptOwnerApplicationResult =
  "applied" | "superseded" | "poisoned" | "deferred";

// Route handlers and instrumentation are separate Next bundles in one process.
const APPLICATIONS_KEY = Symbol.for("maister.prompt-owner-applications.v1");

type ApplicationState = {
  stop: AbortController;
  active: Set<Promise<PromptOwnerApplicationResult>>;
  draining?: Promise<void>;
};
type ApplicationGlobal = typeof globalThis & {
  [APPLICATIONS_KEY]?: ApplicationState;
};

function applicationState(): ApplicationState {
  const shared = globalThis as ApplicationGlobal;

  return (shared[APPLICATIONS_KEY] ??= {
    stop: new AbortController(),
    active: new Set(),
  });
}

/** Capture the complete direct claim-to-release lifetime before aborting it.
 * Keeping the settled results in the drain preserves release failures even
 * when the HTTP waiter finishes before the server starts its database drain.
 */
export function stopPromptOwnerApplications(): Promise<void> {
  const state = applicationState();

  if (state.draining) return state.draining;
  const active = [...state.active];

  log.info(
    { applications: active.length },
    "prompt-owner-applications-stopping",
  );
  state.draining = Promise.allSettled(active).then((results) => {
    const failures = results.filter((result) => result.status === "rejected");

    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "direct prompt owner applications could not drain",
      );
    log.info(
      { applications: active.length },
      "prompt-owner-applications-stopped",
    );
  });
  state.stop.abort();

  return state.draining;
}

class PromptOwnerClaimLostError extends MaisterError {
  constructor() {
    super("CONFLICT", "prompt owner application claim is no longer current", {
      details: { reason: "prompt_owner_claim_lost" },
    });
    Object.setPrototypeOf(this, PromptOwnerClaimLostError.prototype);
  }
}

function claimPredicate(claim: PromptOwnerClaim): SQL | undefined {
  return and(
    eq(executionCommands.id, claim.command.id),
    eq(executionCommands.applicationState, "applying"),
    eq(executionCommands.applicationClaimOwner, claim.token),
    eq(
      executionCommands.applicationAttempts,
      claim.command.applicationAttempts,
    ),
    eq(executionCommands.requestSha256, claim.command.requestSha256!),
    claim.command.terminalEvidenceSha256 === null
      ? isNull(executionCommands.terminalEvidenceSha256)
      : eq(
          executionCommands.terminalEvidenceSha256,
          claim.command.terminalEvidenceSha256,
        ),
  );
}

/** Claim at processing time. A retry deadline orders work fairly; completed
 * commands leave the queue and failing commands yield during their backoff.
 */
export async function claimPromptOwner(input: {
  db: Db;
  owners: PromptOwnerRegistry;
  commandId?: string;
}): Promise<PromptOwnerClaim | null> {
  if (input.owners.size === 0) return null;

  return projectionTransaction(input.db, async (tx) => {
    const [command] = await tx
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.kind, "session.prompt"),
          eq(executionCommands.requestSchema, COMMAND_REQUEST_SCHEMA),
          inArray(executionCommands.ownerKind, [...input.owners.keys()]),
          inArray(executionCommands.state, [...TERMINAL_COMMAND_STATES]),
          or(
            isNotNull(executionCommands.terminalEvidenceSha256),
            and(
              eq(executionCommands.state, "failed"),
              sql`${executionCommands.lastError}->'details'->>'transport' = 'not_sent'`,
            ),
          ),
          inArray(executionCommands.applicationState, ["pending", "applying"]),
          isNull(executionCommands.completionAppliedAt),
          or(
            isNull(executionCommands.applicationNextRetryAt),
            lte(
              executionCommands.applicationNextRetryAt,
              sql`clock_timestamp()`,
            ),
          ),
          or(
            isNull(executionCommands.applicationClaimExpiresAt),
            lte(
              executionCommands.applicationClaimExpiresAt,
              sql`clock_timestamp()`,
            ),
          ),
          input.commandId
            ? eq(executionCommands.id, input.commandId)
            : undefined,
        ),
      )
      .orderBy(
        sql`coalesce(${executionCommands.applicationNextRetryAt}, ${executionCommands.createdAt})`,
        executionCommands.id,
      )
      // The worker's scan skips a busy row for the next one. A waiter naming
      // its own command waits instead: since settlement stopped waiting for
      // the prompt projector (ADR-167 D5 amendment), that projector may still
      // be confirming this row when the waiter claims, and skipping would
      // report a settled turn as pending. Bounded by the transaction budget.
      .for("update", input.commandId ? undefined : { skipLocked: true })
      .limit(1);

    if (!command) return null;
    const token = randomUUID();
    const [claimed] = await tx
      .update(executionCommands)
      .set({
        applicationState: "applying",
        applicationClaimOwner: token,
        applicationClaimExpiresAt: sql`clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(executionCommands.id, command.id))
      .returning();

    log.debug(
      {
        commandId: command.id,
        ownerKind: command.ownerKind,
        ownerVariant: command.ownerRef?.variant,
        token,
      },
      "prompt-owner-claimed",
    );

    return { command: claimed, token };
  });
}

export async function releasePromptOwnerClaim(
  db: Db,
  claim: PromptOwnerClaim,
): Promise<void> {
  await projectionTransaction(db, async (tx) => {
    await tx
      .update(executionCommands)
      .set({
        applicationState: "pending",
        applicationClaimOwner: null,
        applicationClaimExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(claimPredicate(claim));
  });
}

async function renewClaim(db: Db, claim: PromptOwnerClaim): Promise<void> {
  await projectionTransaction(db, async (tx) => {
    const updated = await tx
      .update(executionCommands)
      .set({
        applicationClaimExpiresAt: sql`clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'`,
      })
      .where(
        and(
          claimPredicate(claim),
          sql`${executionCommands.applicationClaimExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: executionCommands.id });

    if (updated.length !== 1) throw new PromptOwnerClaimLostError();
  });
}

/** Output can span many bounded pages. Its separate owner lease is renewed
 * while preparing, and every DB boundary still compares the original token.
 * Aborting preparation cancels the renewal timer and waits for its last write.
 */
async function prepareWithLease(input: {
  db: Db;
  claim: PromptOwnerClaim;
  owners: PromptOwnerRegistry;
  signal: AbortSignal;
  onProgress: (stage: string) => void;
  timeoutMs?: number;
  prepare?: (signal: AbortSignal) => Promise<PreparedPromptOwner>;
}): Promise<PreparedPromptOwner> {
  const renewalStop = new AbortController();
  const leaseLost = new AbortController();
  const deadline = new AbortController();
  const signal = AbortSignal.any([
    input.signal,
    leaseLost.signal,
    deadline.signal,
  ]);
  const timeoutMs = input.timeoutMs ?? PROMPT_OWNER_PREPARE_TIMEOUT_MS;
  const timer = setTimeout(
    () =>
      deadline.abort(
        new MaisterError(
          "PRECONDITION",
          "Prompt owner preparation exceeded its bounded application window",
          { details: { reason: "prompt_owner_prepare_timeout", timeoutMs } },
        ),
      ),
    timeoutMs,
  );
  let rejectAborted: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAborted, { once: true });
    if (signal.aborted) rejectAborted();
  });
  let renewalFailure: { error: unknown } | undefined;
  const renewal = (async (): Promise<void> => {
    while (!renewalStop.signal.aborted && !signal.aborted) {
      try {
        await delay(RENEW_MS, undefined, {
          signal: AbortSignal.any([renewalStop.signal, signal]),
        });
      } catch (error) {
        if (renewalStop.signal.aborted || signal.aborted) return;
        renewalFailure = { error };
        leaseLost.abort(error);

        return;
      }
      try {
        await renewClaim(input.db, input.claim);
      } catch (error) {
        renewalFailure = { error };
        leaseLost.abort(error);

        return;
      }
    }
  })();

  try {
    const preparation = input.prepare
      ? input.prepare(signal)
      : preparePromptOwner({
          db: input.db,
          command: input.claim.command,
          registry: input.owners,
          signal,
          onProgress: input.onProgress,
        });
    const prepared = await Promise.race([preparation, aborted]);

    signal.throwIfAborted();

    return prepared;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", rejectAborted);
    renewalStop.abort();
    await renewal;
    if (renewalFailure) throw renewalFailure.error;
  }
}

function serviceFailure(error: unknown): boolean {
  if (error instanceof MaisterError && error.code === "EXECUTOR_UNAVAILABLE")
    return true;
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const code = "code" in current ? current.code : null;

    // `40P01`: the deadlock victim's work rolled back whole; the retry is a
    // clean attempt, never evidence against the owner.
    if (
      typeof code === "string" &&
      /^(08|53|57P0|40P01|ECONN|EPIPE|ETIMEDOUT)/.test(code)
    )
      return true;
    current = "cause" in current ? current.cause : null;
  }

  return false;
}

async function recordServiceRetry(input: {
  db: Db;
  claim: PromptOwnerClaim;
  error: unknown;
  phase: "prepare" | "apply";
  stage: string;
}): Promise<PromptOwnerApplicationResult> {
  const diagnostic = preservePromptApplicationHistory(
    input.claim.command.applicationError,
    {
      reason: preparationTimedOut(input.error)
        ? "prompt_owner_stalled"
        : "prompt_owner_service_retry",
      phase: input.phase,
      stage: input.stage,
      ...promptApplicationDiagnostic(input.error),
      classification: "transient",
    },
  );

  return recordPendingApplication({ ...input, diagnostic, retryMs: 5_000 });
}

function preparationTimedOut(error: unknown): boolean {
  return (
    error instanceof MaisterError &&
    error.details?.reason === "prompt_owner_prepare_timeout"
  );
}

async function recordPendingApplication(input: {
  db: Db;
  claim: PromptOwnerClaim;
  diagnostic: CommandApplicationError;
  retryMs: number;
  applicationAttempts?: number;
}): Promise<PromptOwnerApplicationResult> {
  await projectionTransaction(input.db, async (tx) => {
    await tx
      .update(executionCommands)
      .set({
        applicationState: "pending",
        applicationClaimOwner: null,
        applicationClaimExpiresAt: null,
        applicationNextRetryAt: sql`clock_timestamp() + ${input.retryMs} * interval '1 millisecond'`,
        applicationError: input.diagnostic,
        ...(input.applicationAttempts === undefined
          ? {}
          : { applicationAttempts: input.applicationAttempts }),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          claimPredicate(input.claim),
          sql`${executionCommands.applicationClaimExpiresAt} > clock_timestamp()`,
        ),
      );
  });
  const fields = { commandId: input.claim.command.id, ...input.diagnostic };

  if (input.diagnostic.reason === "prompt_owner_deferred")
    log.debug(fields, "prompt-owner-domain-pending");
  else
    log.warn(
      fields,
      input.diagnostic.reason === "prompt_owner_service_retry"
        ? "prompt-owner-service-retry"
        : "prompt-owner-application-pending",
    );

  return "deferred";
}

const BOUNDED_AGENT_DEFERRALS = new Set([
  "agent_session_teardown_pending",
  "agent_finalization_pending",
]);

function stalledAgentDeferral(
  error: unknown,
  command: ExecutionCommand,
): boolean {
  if (
    !(error instanceof PromptOwnerDeferred) ||
    !BOUNDED_AGENT_DEFERRALS.has(String(error.details?.causeCode))
  )
    return false;
  const since = command.applicationError?.deferredSince;

  return (
    since !== undefined &&
    Number.isFinite(Date.parse(since)) &&
    Date.now() - Date.parse(since) >= PROMPT_OWNER_PREPARE_TIMEOUT_MS
  );
}

async function recordFailure(input: {
  db: Db;
  claim: PromptOwnerClaim;
  error: unknown;
  phase: "prepare" | "apply";
  stage: string;
  recoveryError?: unknown;
}): Promise<PromptOwnerApplicationResult> {
  const attempts = Math.min(
    MAX_FAILURES,
    input.claim.command.applicationAttempts + 1,
  );
  const poisoned =
    input.error instanceof PromptOwnerInvariantError ||
    attempts >= MAX_FAILURES;
  const diagnostic = promptApplicationDiagnostic(input.error);
  const applicationError = preservePromptApplicationHistory(
    input.claim.command.applicationError,
    {
      reason: poisoned ? "prompt_owner_poisoned" : "prompt_owner_retry",
      phase: input.phase,
      stage: input.stage,
      ...diagnostic,
      classification:
        input.error instanceof PromptOwnerInvariantError
          ? "invariant"
          : poisoned
            ? "exhausted"
            : "transient",
      ...(input.recoveryError
        ? {
            recoveryError: {
              code:
                input.recoveryError instanceof MaisterError
                  ? input.recoveryError.code
                  : "application_failure",
              reason: promptApplicationDiagnostic(input.recoveryError)
                .causeReason,
              message:
                promptApplicationDiagnostic(input.recoveryError).causeMessage ??
                "Application recovery failed",
            },
          }
        : {}),
    },
  );

  return projectionTransaction(input.db, async (tx) => {
    const rows = await tx
      .update(executionCommands)
      .set({
        applicationState: poisoned ? "poisoned" : "pending",
        applicationClaimOwner: null,
        applicationClaimExpiresAt: null,
        applicationAttempts: attempts,
        applicationNextRetryAt: poisoned
          ? null
          : sql`clock_timestamp() + ${Math.min(300_000, 1_000 * 2 ** (attempts - 1))} * interval '1 millisecond'`,
        applicationError,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          claimPredicate(input.claim),
          sql`${executionCommands.applicationClaimExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: executionCommands.id });

    if (rows.length === 0) return "deferred";
    log.warn(
      {
        commandId: input.claim.command.id,
        attempts,
        ...applicationError,
        poisoned,
      },
      "prompt-owner-application-failed",
    );

    return poisoned ? "poisoned" : "deferred";
  });
}

async function commitPreparedOwner(input: {
  db: Db;
  claim: PromptOwnerClaim;
  prepared: PreparedPromptOwner;
  signal: AbortSignal;
  applicationError?: CommandApplicationError;
}): Promise<PromptOwnerApplicationResult> {
  const disposition = await projectionTransaction(input.db, async (tx) => {
    input.signal.throwIfAborted();
    const outcome = await input.prepared.apply(tx);

    input.signal.throwIfAborted();
    const rows = await tx
      .update(executionCommands)
      .set({
        applicationState: outcome,
        completionAppliedAt:
          outcome === "applied" ? sql`clock_timestamp()` : null,
        applicationClaimOwner: null,
        applicationClaimExpiresAt: null,
        applicationNextRetryAt: null,
        applicationError: input.applicationError
          ? preservePromptApplicationHistory(
              input.claim.command.applicationError,
              input.applicationError,
            )
          : input.claim.command.applicationError?.recoveryRequestedAt ||
              input.claim.command.applicationError?.recoveryOrigin ||
              input.claim.command.applicationError?.recoveryError ||
              input.claim.command.applicationError?.deferredSince
            ? preservePromptApplicationHistory(
                input.claim.command.applicationError,
                {
                  ...input.claim.command.applicationError,
                  reason: "prompt_owner_recovered",
                },
              )
            : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          claimPredicate(input.claim),
          sql`${executionCommands.applicationClaimExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: executionCommands.id });

    if (rows.length !== 1) throw new PromptOwnerClaimLostError();

    return outcome;
  });

  commandSignals.wake(input.claim.command.id);
  runEventWakeBus.wake(input.claim.command.runId);
  log.info(
    {
      commandId: input.claim.command.id,
      ownerKind: input.claim.command.ownerKind,
      ownerVariant: input.claim.command.ownerRef?.variant,
      disposition,
    },
    "prompt-owner-applied",
  );

  if (disposition === "applied" && input.prepared.afterCommit) {
    await input.prepared.afterCommit().catch((error: unknown) => {
      log.warn(
        {
          commandId: input.claim.command.id,
          ownerKind: input.claim.command.ownerKind,
          errorType: error instanceof Error ? error.name : "unknown",
        },
        "prompt-owner-cleanup-deferred-to-domain-backstop",
      );
    });
  }

  return disposition;
}

/** Domain writes precede the final token/lease CAS in the same bounded DB
 * transaction. Losing the CAS rolls every domain write back. This respects
 * domain lock order (notably HITL first) instead of locking command then owner.
 */
export async function applyClaimedPromptOwner(input: {
  db: Db;
  claim: PromptOwnerClaim;
  owners: PromptOwnerRegistry;
  signal: AbortSignal;
  prepareTimeoutMs?: number;
}): Promise<PromptOwnerApplicationResult> {
  let phase: "prepare" | "apply" = "prepare";
  let stage = "reconcile";
  const onProgress = (next: string): void => {
    stage = next.slice(0, 128);
  };

  try {
    input.signal.throwIfAborted();
    const evidence = await reconcilePromptCommand({
      db: input.db,
      commandId: input.claim.command.id,
      signal: input.signal,
    });

    if (evidence.disposition === "quarantined") return "poisoned";
    if (evidence.command.applicationClaimOwner !== input.claim.token)
      return "deferred";
    if (evidence.disposition !== "settled") {
      await releasePromptOwnerClaim(input.db, input.claim);

      return "deferred";
    }
    const prepared = await prepareWithLease({
      ...input,
      onProgress,
      timeoutMs: input.prepareTimeoutMs,
    });

    phase = "apply";
    stage = "application";

    return await commitPreparedOwner({ ...input, prepared });
  } catch (error) {
    if (error instanceof PromptOwnerDeferred) {
      const stalled = stalledAgentDeferral(error, input.claim.command);
      const diagnostic = preservePromptApplicationHistory(
        input.claim.command.applicationError,
        {
          reason: stalled ? "prompt_owner_stalled" : "prompt_owner_deferred",
          phase,
          stage,
          ...promptApplicationDiagnostic(error),
          classification: "deferred",
          deferredSince:
            input.claim.command.applicationError?.deferredSince ??
            new Date().toISOString(),
        },
      );

      return recordPendingApplication({
        ...input,
        diagnostic,
        retryMs: stalled ? 5_000 : 1_000,
      });
    }
    if (input.signal.aborted || error instanceof PromptOwnerClaimLostError) {
      await releasePromptOwnerClaim(input.db, input.claim);

      return "deferred";
    }
    if (serviceFailure(error) || preparationTimedOut(error)) {
      return recordServiceRetry({ ...input, error, phase, stage });
    }

    const exhausted =
      error instanceof PromptOwnerInvariantError ||
      input.claim.command.applicationAttempts + 1 >= MAX_FAILURES;
    const parsed = PromptOwnerSchema.safeParse({
      kind: input.claim.command.ownerKind,
      ref: input.claim.command.ownerRef,
    });
    const adapter = parsed.success
      ? input.owners.get(parsed.data.kind)
      : undefined;

    if (exhausted && parsed.success && adapter?.prepareFailure) {
      const originalStage = stage;
      const diagnostic = preservePromptApplicationHistory(
        input.claim.command.applicationError,
        {
          reason: "prompt_owner_application_failed",
          phase,
          stage,
          ...promptApplicationDiagnostic(error),
          classification:
            error instanceof PromptOwnerInvariantError
              ? "invariant"
              : "exhausted",
        },
      );

      try {
        const prepareFailure = adapter.prepareFailure;
        const owner = parsed.data;

        onProgress("failure_finalization");
        const prepared = await prepareWithLease({
          ...input,
          onProgress,
          timeoutMs: input.prepareTimeoutMs,
          prepare: (signal) =>
            prepareFailure({
              db: input.db,
              owner,
              command: input.claim.command,
              error: diagnostic,
              signal,
              onProgress,
            }),
        });
        const disposition = await commitPreparedOwner({
          ...input,
          prepared,
          applicationError: diagnostic,
        });

        return disposition;
      } catch (recoveryError) {
        if (
          input.signal.aborted ||
          recoveryError instanceof PromptOwnerClaimLostError
        ) {
          await releasePromptOwnerClaim(input.db, input.claim);

          return "deferred";
        }

        if (
          recoveryError instanceof PromptOwnerDeferred ||
          serviceFailure(recoveryError) ||
          preparationTimedOut(recoveryError)
        ) {
          const recoveryDiagnostic = promptApplicationDiagnostic(recoveryError);
          const pending = preservePromptApplicationHistory(
            input.claim.command.applicationError,
            {
              ...diagnostic,
              reason: "prompt_owner_recovery_pending",
              classification:
                recoveryError instanceof PromptOwnerDeferred
                  ? "deferred"
                  : "transient",
              recoveryOrigin:
                diagnostic.recoveryOrigin ??
                promptApplicationFailureSnapshot(diagnostic),
              recoveryError: {
                code: recoveryDiagnostic.causeCode ?? "application_failure",
                reason: recoveryDiagnostic.causeReason,
                message:
                  recoveryDiagnostic.causeMessage ??
                  "Application recovery is pending",
              },
            },
          );

          return recordPendingApplication({
            ...input,
            diagnostic: pending,
            retryMs: 5_000,
            applicationAttempts:
              error instanceof PromptOwnerInvariantError
                ? input.claim.command.applicationAttempts
                : Math.min(
                    MAX_FAILURES,
                    input.claim.command.applicationAttempts + 1,
                  ),
          });
        }

        return recordFailure({
          ...input,
          error,
          phase,
          stage: originalStage,
          recoveryError,
        });
      }
    }

    return recordFailure({ ...input, error, phase, stage });
  }
}

export async function applyPromptOwner(input: {
  db: Db;
  owners: PromptOwnerRegistry;
  commandId: string;
  signal: AbortSignal;
}): Promise<PromptOwnerApplicationResult> {
  const state = applicationState();

  if (isApplicationStopping() || state.stop.signal.aborted)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "direct prompt owner applications are shutting down",
      { details: { commandId: input.commandId } },
    );
  const signal = AbortSignal.any([input.signal, state.stop.signal]);
  // Register before even the claim transaction begins; quiesce also joins a
  // claim that is waiting on a database lock and releases it once acquired.
  const application = Promise.resolve().then(
    async (): Promise<PromptOwnerApplicationResult> => {
      if (isApplicationStopping() || signal.aborted) return "deferred";
      const claim = await claimPromptOwner(input);

      if (!claim) return "deferred";

      return applyClaimedPromptOwner({ ...input, claim, signal });
    },
  );

  state.active.add(application);
  const finished = (): void => {
    state.active.delete(application);
  };

  // Observe both branches; a rejecting finally-derived promise would itself
  // be unhandled while the caller and saved shutdown drain await the original.
  void application.then(finished, finished);

  return application;
}
