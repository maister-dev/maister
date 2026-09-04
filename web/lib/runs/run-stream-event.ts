import "server-only";

import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Db } from "@/lib/execution-host/db";
import { assertRuntimeEventPayloadSafe } from "@/lib/execution-host/runtime-events";
import { executionEvents, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";

export type ManagerRunStreamEvent = {
  readonly type: string;
  readonly data?: Record<string, unknown>;
};

export type ManagerRunStreamAppend = {
  readonly runId: string;
  // A stable domain-operation key. It is the manager equivalent of a host
  // stream position: retries return the same event rather than allocating a
  // second browser-visible sequence.
  readonly sourceKey: string;
  readonly event: ManagerRunStreamEvent;
  readonly occurredAt?: Date;
};

export type ManagerRunStreamAppendResult = {
  readonly mode: "canonical_events_v1";
  readonly eventId: string;
  readonly runSequence: string;
};

const MANAGER_PAYLOAD_SCHEMA = "maister.manager.run-stream.v1";

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new MaisterError("PRECONDITION", "manager run event contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new MaisterError("PRECONDITION", "manager run event contains a non-JSON value");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function deterministicManagerEventId(runId: string, sourceKey: string): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const name = `urn:maister:execution-event:manager:run:${encodeURIComponent(runId)}:source:${encodeURIComponent(sourceKey)}`;
  const bytes = Buffer.from(
    createHash("sha1")
      .update(namespace.toString("hex"), "hex")
      .update(name, "utf8")
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function managerPayload(event: ManagerRunStreamEvent): Record<string, unknown> {
  if (!event.type || event.type.length > 128) {
    throw new MaisterError("PRECONDITION", "manager run event type is required and bounded");
  }
  const payload = event.data ?? {};
  try {
    assertRuntimeEventPayloadSafe(payload);
  } catch (error) {
    throw new MaisterError(
      "PRECONDITION",
      error instanceof Error ? error.message : "manager run event payload is unsafe",
      { details: { reason: "manager_event_payload_invalid" } },
    );
  }
  return payload;
}

// This is the canonical manager write path. The run row lock allocates one
// contiguous sequence shared with host ingestion; source-key idempotency makes
// retry after a committed response loss deterministic.
export async function appendManagerRunStreamEvent(
  db: Db,
  input: ManagerRunStreamAppend,
): Promise<ManagerRunStreamAppendResult> {
  if (!input.sourceKey || input.sourceKey.length > 512) {
    throw new MaisterError("PRECONDITION", "manager run event source key is required and bounded");
  }
  const payload = managerPayload(input.event);
  const payloadJson = stableJson(payload);
  const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
  const payloadBytes = new TextEncoder().encode(payloadJson).byteLength;

  const result = await db.transaction(async (tx) => {
    const lockedRuns = await tx
      .select({ id: runs.id, nextSequence: runs.nextExecutionEventSequence })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("update")
      .limit(1);
    const lockedRun = lockedRuns[0];
    if (!lockedRun) {
      throw new MaisterError("PRECONDITION", `run ${input.runId} disappeared during manager event append`);
    }
    const existingRows = await tx
      .select({
        id: executionEvents.id,
        eventType: executionEvents.eventType,
        payloadSha256: executionEvents.payloadSha256,
        runSequence: executionEvents.runSequence,
      })
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.source, "manager"),
          eq(executionEvents.runId, input.runId),
          eq(executionEvents.sourceKey, input.sourceKey),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      if (
        existing.eventType !== input.event.type ||
        existing.payloadSha256 !== payloadSha256 ||
        existing.runSequence === null
      ) {
        throw new MaisterError("CONFLICT", "manager event source key was reused with different immutable data", {
          details: { reason: "event_identity_conflict", sourceKey: input.sourceKey },
        });
      }
      return { eventId: existing.id, runSequence: existing.runSequence };
    }
    const runSequence = lockedRun.nextSequence;
    const eventId = deterministicManagerEventId(input.runId, input.sourceKey);
    await tx.insert(executionEvents).values({
      id: eventId,
      source: "manager",
      sourceKey: input.sourceKey,
      runId: input.runId,
      eventType: input.event.type,
      payloadSchema: MANAGER_PAYLOAD_SCHEMA,
      payload,
      payloadSha256,
      payloadBytes,
      occurredAt: input.occurredAt ?? new Date(),
      runSequence,
      ingestDisposition: "accepted",
    });
    await tx
      .update(runs)
      .set({ nextExecutionEventSequence: runSequence + 1n })
      .where(eq(runs.id, input.runId));
    return { eventId, runSequence };
  });
  runEventWakeBus.wake(input.runId);
  return {
    mode: "canonical_events_v1",
    eventId: result.eventId,
    runSequence: result.runSequence.toString(),
  };
}
