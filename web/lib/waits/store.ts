import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { WaitJson, WaitResult, WaitSignal } from "@/lib/waits/contracts";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  canonicalCommandJson,
  CommandJsonError,
} from "../../../runtime/command-json";

import {
  runs,
  runWaitActions,
  runWaitDeliveries,
  runWaits,
} from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { notifyWaitChanged } from "@/lib/runs/peek-wake";
import { RESERVED_SIGNAL_OUTCOMES } from "@/lib/waits/contracts";
import { compileWaitPayloadSchema } from "@/lib/waits/payload-schema";

const log = pino({
  name: "wait-store",
  level: process.env.LOG_LEVEL ?? "info",
});
const MAX_RECEIPT_BYTES = 32 * 1024;

export type WaitTx = Pick<
  NodePgDatabase,
  "select" | "insert" | "update" | "execute"
>;
export type WaitDb = {
  transaction<T>(work: (tx: WaitTx) => Promise<T>): Promise<T>;
};
export type WaitRow = typeof runWaits.$inferSelect;

export type WaitAddress = {
  readonly projectId: string;
  readonly runId: string;
  readonly waitId: string;
};

type Delivery = typeof runWaitDeliveries.$inferSelect;
type SignalInput = WaitAddress & {
  readonly actor: {
    readonly kind: Delivery["sourceKind"];
    readonly id: string;
  };
  readonly idempotencyKey: string;
  readonly signal: WaitSignal;
};

type SignalReceipt = {
  readonly receiptId: string;
  readonly waitId: string;
  readonly disposition: Delivery["disposition"] | "duplicate";
  readonly application: Delivery["application"];
  readonly reason: string | null;
};

type ResultFact = Omit<WaitResult, "schemaVersion" | "resolvedAt">;

export function encodeWaitDigest(value: WaitJson): string {
  let canonical: string;

  try {
    canonical = canonicalCommandJson(value);
  } catch (error: unknown) {
    if (!(error instanceof CommandJsonError)) throw error;
    throw new MaisterError("CONFIG", "Wait input is not valid JSON", {
      details: { reason: "wait_invalid_payload" },
    });
  }

  // PostgreSQL jsonb cannot represent an embedded NUL. Check the original
  // JSON string escape rather than accepting a database-dependent failure.
  if (
    /(?<!\\)(?:\\\\)*\\u0000/.test(canonical) ||
    Buffer.byteLength(canonical, "utf8") > MAX_RECEIPT_BYTES
  ) {
    throw new MaisterError("CONFIG", "Wait input exceeds its JSON bounds", {
      details: { reason: "wait_invalid_payload" },
    });
  }

  return createHash("sha256").update(canonical).digest("hex");
}

function scopeOf(address: WaitAddress) {
  return and(
    eq(runWaits.id, address.waitId),
    eq(runWaits.runId, address.runId),
    eq(runWaits.projectId, address.projectId),
  );
}

export function waitConflict(
  address: WaitAddress,
  reason: string,
): MaisterError {
  log.warn({ ...address, reason }, "wait command refused");

  return new MaisterError(
    "CONFLICT",
    "Wait command conflicts with current state",
    {
      details: { reason, waitId: address.waitId },
    },
  );
}

export async function lockWait(
  tx: WaitTx,
  address: WaitAddress,
): Promise<WaitRow> {
  const [wait] = await tx
    .select()
    .from(runWaits)
    .where(scopeOf(address))
    .for("update");

  if (!wait) {
    throw new MaisterError("PRECONDITION", "Wait not found", {
      details: { reason: "wait_not_found" },
    });
  }

  return wait;
}

export async function readWaitClock(tx: WaitTx): Promise<Date> {
  const {
    rows: [clock],
  } = await tx.execute<{ now: string }>(
    sql`SELECT clock_timestamp()::text AS now`,
  );

  return new Date(clock.now);
}

export function signalWaitOutcomes(
  wait: Pick<WaitRow, "condition" | "conditionKind">,
): string[] {
  const ciPush =
    wait.conditionKind === "ci" &&
    wait.condition.parameters.transport === "push";

  if (wait.conditionKind !== "signal" && !ciPush) return [];

  return wait.condition.outcomes.filter(
    (outcome) =>
      !RESERVED_SIGNAL_OUTCOMES.includes(outcome) ||
      (ciPush && outcome === "cancelled"),
  );
}

function signalDecision(
  wait: WaitRow,
  signal: WaitSignal,
  now: Date,
): Pick<Delivery, "disposition" | "application" | "reason"> {
  const ciPush =
    wait.conditionKind === "ci" &&
    wait.condition.parameters.transport === "push";
  const open =
    wait.state === "open" && wait.deadlineAt && now < wait.deadlineAt;
  const reserved =
    ciPush &&
    wait.state === "reserved" &&
    wait.reservedUntil &&
    now < wait.reservedUntil;

  if (!open && !reserved) {
    return {
      disposition: "rejected",
      application: "not_applied",
      reason: "wait_closed",
    };
  }
  if (
    signal.name !== wait.condition.parameters.name ||
    !signalWaitOutcomes(wait).includes(signal.outcome)
  ) {
    return {
      disposition: "rejected",
      application: "not_applied",
      reason: "wait_invalid_payload",
    };
  }
  if (wait.bindingHeadSha !== null && wait.bindingHeadSha !== signal.headSha) {
    return {
      disposition: "stale",
      application: "not_applied",
      reason: "wait_wrong_head",
    };
  }

  return { disposition: "accepted", application: "pending", reason: null };
}

export function normalizeWaitIdempotencyKey(input: string): string {
  const key = input.trim();

  if (key.length === 0 || key.length > 128 || key.includes("\0")) {
    throw new MaisterError("CONFIG", "Invalid wait idempotency key", {
      details: { reason: "wait_invalid_payload" },
    });
  }

  return key;
}

/** Record a receipt after authenticating its source. */
export async function recordWaitSignal(
  db: WaitDb,
  input: SignalInput,
): Promise<SignalReceipt> {
  return db.transaction((tx) => recordWaitSignalInTransaction(tx, input));
}

export async function recordWaitSignalInTransaction(
  tx: WaitTx,
  input: SignalInput,
): Promise<SignalReceipt> {
  const address: WaitAddress = {
    projectId: input.projectId,
    runId: input.runId,
    waitId: input.waitId,
  };
  const key = normalizeWaitIdempotencyKey(input.idempotencyKey);
  const bodyDigest = encodeWaitDigest(input.signal);
  const receiptId = encodeWaitDigest([
    input.waitId,
    input.actor.kind,
    input.actor.id,
    key,
  ]);

  log.debug({ ...address, receiptId }, "recording wait signal");
  await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.id, address.runId), eq(runs.projectId, address.projectId)),
    )
    .for("key share");
  const wait = await lockWait(tx, address);
  const [prior] = await tx
    .select()
    .from(runWaitDeliveries)
    .where(eq(runWaitDeliveries.id, receiptId));

  if (prior) {
    if (prior.payloadDigest !== bodyDigest)
      throw waitConflict(address, "wait_key_conflict");

    return {
      receiptId,
      waitId: wait.id,
      disposition:
        prior.disposition === "accepted" ? "duplicate" : prior.disposition,
      application: prior.application,
      reason: prior.reason,
    } satisfies SignalReceipt;
  }

  const receivedAt = await readWaitClock(tx);
  let disposition = signalDecision(wait, input.signal, receivedAt);
  const schema = wait.condition.parameters.payload_schema;

  if (
    disposition.disposition === "accepted" &&
    (typeof schema === "boolean" ||
      (schema && typeof schema === "object" && !Array.isArray(schema))) &&
    !compileWaitPayloadSchema(schema)(input.signal.payload)
  ) {
    disposition = {
      disposition: "rejected",
      application: "not_applied",
      reason: "wait_invalid_payload",
    };
  }

  await tx.insert(runWaitDeliveries).values({
    id: receiptId,
    waitId: wait.id,
    sourceKind: input.actor.kind,
    sourceId: input.actor.id,
    idempotencyKey: key,
    payloadDigest: bodyDigest,
    body: input.signal,
    receivedAt,
    ...disposition,
  });
  await notifyWaitChanged(tx, address.runId);

  if (disposition.disposition === "accepted")
    await emitDomainEvent({
      db: tx,
      kind: "run.wait_delivery_recorded",
      projectId: address.projectId,
      runId: address.runId,
      actor:
        input.actor.kind === "operator"
          ? { type: "user", id: input.actor.id }
          : { type: "system", id: null },
      occurredAt: receivedAt,
      payload: { schemaVersion: 1, waitId: wait.id, receiptId },
    });

  const receipt = { receiptId, waitId: wait.id, ...disposition };

  log.info(
    { ...address, receiptId, disposition: receipt.disposition },
    "wait receipt recorded",
  );

  return receipt;
}

/** Called under the parent lifecycle lock, before writing any dependent effects. */
export async function persistWaitResult(
  tx: WaitTx,
  address: WaitAddress,
  waitVersion: number,
  fact: ResultFact,
): Promise<{ result: WaitResult; digest: string }> {
  const wait = await lockWait(tx, address);

  if (wait.state !== "open") throw waitConflict(address, "wait_closed");
  if (wait.version !== waitVersion)
    throw waitConflict(address, "wait_version_changed");
  if (!wait.condition.outcomes.includes(fact.outcome)) {
    throw new MaisterError("PRECONDITION", "Wait outcome is not declared");
  }
  const now = await readWaitClock(tx);
  const result: WaitResult = {
    ...fact,
    schemaVersion: 1,
    resolvedAt: now.toISOString(),
  };
  const digest = encodeWaitDigest(result);
  const [winning] = await tx
    .update(runWaits)
    .set({
      state: "resolved",
      result,
      resultDigest: digest,
      resolvedAt: now,
      queuedAt: now,
      resumeState: "queued",
      version: waitVersion + 1,
    })
    .where(
      and(
        scopeOf(address),
        eq(runWaits.version, waitVersion),
        eq(runWaits.state, "open"),
      ),
    )
    .returning({ id: runWaits.id });

  if (!winning) throw waitConflict(address, "wait_version_changed");
  log.debug(
    { ...address, version: waitVersion, source: fact.source },
    "claimed wait result",
  );

  return { result, digest };
}

type ExtendWaitDeadlineInput = WaitAddress & {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly deadline: Date;
};

export async function extendWaitDeadline(
  db: WaitDb,
  input: ExtendWaitDeadlineInput,
): Promise<{ actionReceiptId: string; version: number; state: "open" }> {
  return db.transaction((tx) => extendWaitDeadlineInTransaction(tx, input));
}

export async function extendWaitDeadlineInTransaction(
  tx: WaitTx,
  input: ExtendWaitDeadlineInput,
): Promise<{ actionReceiptId: string; version: number; state: "open" }> {
  const address: WaitAddress = {
    projectId: input.projectId,
    runId: input.runId,
    waitId: input.waitId,
  };
  const key = normalizeWaitIdempotencyKey(input.idempotencyKey);
  const reason = input.reason.trim();

  if (
    reason.length === 0 ||
    reason.length > 1024 ||
    !Number.isFinite(input.deadline.getTime())
  ) {
    throw new MaisterError("CONFIG", "Invalid wait extension");
  }
  const actionReceiptId = encodeWaitDigest([address.waitId, input.userId, key]);
  const payloadDigest = encodeWaitDigest([
    "extend",
    input.expectedVersion,
    reason,
    input.deadline.toISOString(),
  ]);

  const wait = await lockWait(tx, address);
  const [prior] = await tx
    .select()
    .from(runWaitActions)
    .where(eq(runWaitActions.id, actionReceiptId));

  if (prior) {
    if (prior.payloadDigest !== payloadDigest)
      throw waitConflict(address, "wait_key_conflict");

    return {
      actionReceiptId,
      version: prior.resultingVersion,
      state: "open",
    };
  }

  if (wait.state !== "open" || !wait.deadlineAt || !wait.absoluteCapAt) {
    throw waitConflict(address, "wait_closed");
  }
  if (wait.version !== input.expectedVersion)
    throw waitConflict(address, "wait_version_changed");
  const now = await readWaitClock(tx);

  if (now >= wait.deadlineAt)
    throw waitConflict(address, "wait_deadline_elapsed");
  if (
    input.deadline <= wait.deadlineAt ||
    input.deadline > wait.absoluteCapAt
  ) {
    throw new MaisterError(
      "PRECONDITION",
      "New wait deadline is outside the allowed range",
      {
        details: { reason: "wait_deadline_cap", waitId: wait.id },
      },
    );
  }

  const version = wait.version + 1;
  const response = { actionReceiptId, version, state: "open" as const };

  await tx
    .update(runWaits)
    .set({
      version,
      deadlineAt: input.deadline,
      // Keep PostgreSQL's precision when the timer is the next due fact.
      nextDueAt: sql`least(${runWaits.timerAt}, ${input.deadline.toISOString()}::timestamptz)`,
    })
    .where(scopeOf(address));
  await tx.insert(runWaitActions).values({
    id: actionReceiptId,
    waitId: wait.id,
    userId: input.userId,
    idempotencyKey: key,
    payloadDigest,
    action: "extend",
    reason,
    expectedVersion: wait.version,
    resultingVersion: version,
    response,
    createdAt: now,
  });
  await notifyWaitChanged(tx, address.runId);
  log.debug({ ...address, actionReceiptId, version }, "extended wait deadline");

  return response;
}
