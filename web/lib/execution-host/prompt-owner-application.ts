import "server-only";

import type { Db } from "./db";
import type { PreparedPromptOwner, PromptOwnerRegistry } from "./prompt-owners";
import type { SQL } from "drizzle-orm";
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
import { projectionTransaction } from "./events/projection-transaction";
import { runEventWakeBus } from "./events/run-wake";
import { commandSignals } from "./signals";
import { TERMINAL_COMMAND_STATES } from "./types";

import { executionCommands } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "prompt-owner-application",
  level: process.env.LOG_LEVEL ?? "info",
});
const LEASE_MS = 30_000;
const RENEW_MS = 10_000;
const MAX_FAILURES = 5;

export type PromptOwnerClaim = Readonly<{
  command: ExecutionCommand;
  token: string;
}>;
export type PromptOwnerApplicationResult =
  | "applied"
  | "superseded"
  | "poisoned"
  | "deferred";

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
      .for("update", { skipLocked: true })
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
}): Promise<PreparedPromptOwner> {
  const renewalStop = new AbortController();
  const leaseLost = new AbortController();
  const signal = AbortSignal.any([input.signal, leaseLost.signal]);
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
    const prepared = await preparePromptOwner({
      db: input.db,
      command: input.claim.command,
      registry: input.owners,
      signal,
    });

    signal.throwIfAborted();

    return prepared;
  } finally {
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

    if (
      typeof code === "string" &&
      /^(08|53|57P0|ECONN|EPIPE|ETIMEDOUT)/.test(code)
    )
      return true;
    current = "cause" in current ? current.cause : null;
  }

  return false;
}

async function recordFailure(input: {
  db: Db;
  claim: PromptOwnerClaim;
  error: unknown;
  phase: "prepare" | "apply";
}): Promise<PromptOwnerApplicationResult> {
  const attempts = input.claim.command.applicationAttempts + 1;
  const poisoned =
    input.error instanceof PromptOwnerInvariantError ||
    attempts >= MAX_FAILURES;
  const causeCode =
    input.error instanceof PromptOwnerInvariantError
      ? String(input.error.details?.causeCode)
      : input.error instanceof MaisterError
        ? input.error.code
        : "application_failure";

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
        applicationError: {
          reason: poisoned ? "prompt_owner_poisoned" : "prompt_owner_retry",
          phase: input.phase,
          causeCode,
        },
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
        phase: input.phase,
        causeCode,
        poisoned,
      },
      "prompt-owner-application-failed",
    );

    return poisoned ? "poisoned" : "deferred";
  });
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
}): Promise<PromptOwnerApplicationResult> {
  let phase: "prepare" | "apply" = "prepare";

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
    const prepared = await prepareWithLease(input);

    phase = "apply";
    const disposition = await projectionTransaction(input.db, async (tx) => {
      input.signal.throwIfAborted();
      const outcome = await prepared.apply(tx);

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
          applicationError: null,
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

    if (disposition === "applied" && prepared.afterCommit) {
      await prepared.afterCommit().catch((error: unknown) => {
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
  } catch (error) {
    if (error instanceof PromptOwnerDeferred) {
      await projectionTransaction(input.db, async (tx) => {
        await tx
          .update(executionCommands)
          .set({
            applicationState: "pending",
            applicationClaimOwner: null,
            applicationClaimExpiresAt: null,
            applicationNextRetryAt: sql`clock_timestamp() + interval '1 second'`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(claimPredicate(input.claim));
      });
      log.debug(
        {
          commandId: input.claim.command.id,
          causeCode: error.details?.causeCode,
        },
        "prompt-owner-domain-pending",
      );

      return "deferred";
    }
    if (serviceFailure(error)) {
      await releasePromptOwnerClaim(input.db, input.claim);
      throw error;
    }
    if (input.signal.aborted || error instanceof PromptOwnerClaimLostError) {
      await releasePromptOwnerClaim(input.db, input.claim);

      return "deferred";
    }

    return recordFailure({ ...input, error, phase });
  }
}

export async function applyPromptOwner(input: {
  db: Db;
  owners: PromptOwnerRegistry;
  commandId: string;
  signal: AbortSignal;
}): Promise<PromptOwnerApplicationResult> {
  const claim = await claimPromptOwner(input);

  if (!claim) return "deferred";

  return applyClaimedPromptOwner({ ...input, claim });
}
