import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { TranscriptMessage } from "@/components/run-transcript/transcript-view";

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  coalesceSessionUpdates,
  type CoalesceEntry,
} from "@/lib/run-transcript/coalesce";

const { executionEventConsumers, executionEvents, runMessages, runs } = schema;

type DbClient = NodePgDatabase<typeof schema>;

function db(): DbClient {
  return getDb();
}

const TRANSCRIPT_CONSUMER_NAME = "canonical-run-transcript-v1";

const RESET_EVENT_TYPES = new Set([
  "session.permission_request",
  "session.hook_trip",
  "session.exited",
  "session.crashed",
]);

export type ProjectRunTranscriptResult = {
  status: "projected" | "missing-run" | "missing-events" | "unchanged";
  nodeAttempts: number;
  rowsUpserted: number;
};

// Canonical runs derive the same coalesced transcript from manager-owned
// execution_events. This intentionally replays durable database history; it
// never reaches into an execution host's event file. A consumer cursor makes
// the reconcile-on-read path a no-op after the durable event frontier has been
// projected, including when a non-transcript lifecycle event is appended.
async function projectCanonicalRunTranscript(
  runId: string,
  client: DbClient,
): Promise<ProjectRunTranscriptResult> {
  const rows = await client
    .select({
      id: executionEvents.id,
      eventType: executionEvents.eventType,
      payload: executionEvents.payload,
      runSequence: executionEvents.runSequence,
    })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.runId, runId),
        eq(executionEvents.ingestDisposition, "accepted"),
      ),
    )
    .orderBy(asc(executionEvents.runSequence));
  const byAttempt = new Map<string | null, CoalesceEntry[]>();

  for (const row of rows) {
    if (row.runSequence === null || !row.payload) continue;
    const nodeAttemptId =
      typeof row.payload.nodeAttemptId === "string"
        ? row.payload.nodeAttemptId
        : null;
    const entries = byAttempt.get(nodeAttemptId) ?? [];
    if (row.eventType === "session.update") {
      entries.push({
        kind: "update",
        update: row.payload.update,
        supervisorEventId: row.runSequence.toString(),
      });
    } else if (RESET_EVENT_TYPES.has(row.eventType)) {
      entries.push({ kind: "reset" });
    }
    byAttempt.set(nodeAttemptId, entries);
  }

  const ownedAttempts = await client
    .select({ id: schema.nodeAttempts.id })
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId));
  const ownedAttemptIds = new Set(ownedAttempts.map((attempt) => attempt.id));
  let rowsUpserted = 0;
  let nodeAttempts = 0;
  const latestRunSequence = rows.at(-1)?.runSequence ?? null;

  if (latestRunSequence === null) {
    return { status: "missing-events", nodeAttempts, rowsUpserted };
  }

  await client.transaction(async (tx) => {
    await tx
      .insert(executionEventConsumers)
      .values({ consumerName: TRANSCRIPT_CONSUMER_NAME, runId })
      .onConflictDoNothing();
    const [consumer] = await tx
      .select({ lastRunSequence: executionEventConsumers.lastRunSequence })
      .from(executionEventConsumers)
      .where(
        and(
          eq(executionEventConsumers.consumerName, TRANSCRIPT_CONSUMER_NAME),
          eq(executionEventConsumers.runId, runId),
        ),
      )
      .for("update")
      .limit(1);
    if (!consumer) {
      throw new Error("canonical transcript consumer row disappeared");
    }
    if (
      consumer.lastRunSequence !== null &&
      consumer.lastRunSequence >= latestRunSequence
    ) {
      return;
    }

    const hasNewTranscriptEvent = rows.some(
      (row) =>
        row.runSequence !== null &&
        (consumer.lastRunSequence === null ||
          row.runSequence > consumer.lastRunSequence) &&
        (row.eventType === "session.update" || RESET_EVENT_TYPES.has(row.eventType)),
    );

    if (!hasNewTranscriptEvent) {
      await tx
        .update(executionEventConsumers)
        .set({
          lastRunSequence: latestRunSequence,
          state: "ready",
          attempts: 0,
          nextRetryAt: null,
          poisonEventId: null,
          lastError: null,
          claimOwner: null,
          claimExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(executionEventConsumers.consumerName, TRANSCRIPT_CONSUMER_NAME),
            eq(executionEventConsumers.runId, runId),
          ),
        );
      return;
    }

    for (const [nodeAttemptId, entries] of byAttempt) {
      if (nodeAttemptId && !ownedAttemptIds.has(nodeAttemptId)) {
        throw new MaisterError(
          "CONFLICT",
          `canonical transcript event names node attempt outside run ${runId}`,
          { details: { reason: "transcript_node_attempt_mismatch" } },
        );
      }
      if (nodeAttemptId) nodeAttempts += 1;
      for (const message of coalesceSessionUpdates(entries)) {
        await tx
          .insert(runMessages)
          .values({
            id: randomUUID(),
            runId,
            nodeAttemptId,
            sequence: message.sequence,
            role: message.role,
            content: message.content,
            supervisorEventId: message.supervisorEventId,
          })
          .onConflictDoUpdate({
            target: [
              runMessages.runId,
              runMessages.nodeAttemptId,
              runMessages.sequence,
            ],
            set: {
              content: message.content,
              supervisorEventId: message.supervisorEventId,
            },
          });
        rowsUpserted += 1;
      }
    }

    await tx
      .update(executionEventConsumers)
      .set({
        lastRunSequence: latestRunSequence,
        state: "ready",
        attempts: 0,
        nextRetryAt: null,
        poisonEventId: null,
        lastError: null,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(executionEventConsumers.consumerName, TRANSCRIPT_CONSUMER_NAME),
          eq(executionEventConsumers.runId, runId),
        ),
      );
  });

  return {
    status: rowsUpserted > 0 ? "projected" : "unchanged",
    nodeAttempts,
    rowsUpserted,
  };
}

// Reconcile-on-read is exclusively against manager-owned event history. Legacy
// runtime files are imported before cutover; this runtime path never reads one.
export async function projectRunTranscript(
  runId: string,
  opts: { client?: DbClient; runtimeRoot?: string } = {},
): Promise<ProjectRunTranscriptResult> {
  const client = opts.client ?? db();
  const [run] = await client
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, runId));

  if (!run) return { status: "missing-run", nodeAttempts: 0, rowsUpserted: 0 };
  return projectCanonicalRunTranscript(runId, client);
}

export type RunNodeTranscript = {
  messages: TranscriptMessage[];
  // Latest usage of the node's most recent attempt, if the agent reported it.
  usage: { used: number; size: number } | null;
};

export type WholeRunTranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  supervisorEventId: string;
};

export type WholeRunTranscriptFeed = {
  messages: WholeRunTranscriptMessage[];
  lastEventAt: Date | null;
};

// Read model: the transcript for a node's LATEST attempt, as the renderer
// consumes it (raw rows — the shared TranscriptView parses content itself).
export async function getRunNodeTranscript(
  runId: string,
  nodeId: string,
  opts: { client?: DbClient } = {},
): Promise<RunNodeTranscript | null> {
  const client = opts.client ?? db();
  const [attempt] = await client
    .select({ id: schema.nodeAttempts.id })
    .from(schema.nodeAttempts)
    .where(
      and(
        eq(schema.nodeAttempts.runId, runId),
        eq(schema.nodeAttempts.nodeId, nodeId),
      ),
    )
    .orderBy(desc(schema.nodeAttempts.attempt))
    .limit(1);

  // No attempt yet (a pending node, or never-run) → empty transcript. The route
  // (T-B3) validates the nodeId against the compiled graph for unknown nodes.
  if (!attempt) return { messages: [], usage: null };

  const rows = await client
    .select({
      id: runMessages.id,
      role: runMessages.role,
      content: runMessages.content,
      createdAt: runMessages.createdAt,
    })
    .from(runMessages)
    // Filter by BOTH runId and nodeAttemptId — defense-in-depth so a row that
    // was somehow mis-attributed (its run_id ≠ this run) can never surface
    // under this run's authorization.
    .where(
      and(
        eq(runMessages.runId, runId),
        eq(runMessages.nodeAttemptId, attempt.id),
      ),
    )
    .orderBy(asc(runMessages.sequence));

  const messages: TranscriptMessage[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.createdAt.toISOString(),
  }));

  let usage: { used: number; size: number } | null = null;

  for (const r of rows) {
    if (r.role !== "system") continue;
    try {
      const parsed = JSON.parse(r.content) as {
        kind?: string;
        used?: number;
        size?: number;
      };

      if (parsed.kind === "usage") {
        usage = { used: parsed.used ?? 0, size: parsed.size ?? 0 };
      }
    } catch {
      /* not a JSON system payload (e.g. plain text) — ignore */
    }
  }

  return { messages, usage };
}

// Read model: the whole-run transcript for an agent or non-node session. Its
// records were projected from the canonical event ledger, including rows with
// no nodeAttemptId.
export async function getAgentRunTranscript(
  runId: string,
  opts: { client?: DbClient; runtimeRoot?: string } = {},
): Promise<RunNodeTranscript> {
  const feed = await getWholeRunTranscriptMessages(runId, opts);

  // The events log carries no per-message wall-clock; `createdAt` is left empty
  // and the renderer guards it (no timestamp shown) — deliberate, not a gap.
  const messages: TranscriptMessage[] = feed.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: "",
  }));

  let usage: { used: number; size: number } | null = null;

  for (const m of feed.messages) {
    if (m.role !== "system") continue;
    try {
      const parsed = JSON.parse(m.content) as {
        kind?: string;
        used?: number;
        size?: number;
      };

      if (parsed.kind === "usage") {
        usage = { used: parsed.used ?? 0, size: parsed.size ?? 0 };
      }
    } catch {
      /* not a JSON usage payload — ignore */
    }
  }

  return { messages, usage };
}

export async function getWholeRunTranscriptMessages(
  runId: string,
  opts: { client?: DbClient; runtimeRoot?: string } = {},
): Promise<WholeRunTranscriptFeed> {
  const client = opts.client ?? db();
  const [run] = await client
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, runId));

  if (!run) return { messages: [], lastEventAt: null };
  await projectCanonicalRunTranscript(runId, client);
  const messages = await client
    .select({
      id: runMessages.id,
      role: runMessages.role,
      content: runMessages.content,
      supervisorEventId: runMessages.supervisorEventId,
      createdAt: runMessages.createdAt,
    })
    .from(runMessages)
    .where(eq(runMessages.runId, runId))
    .orderBy(asc(runMessages.createdAt), asc(runMessages.sequence));
  return {
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      supervisorEventId: message.supervisorEventId ?? message.id,
    })),
    lastEventAt: messages.at(-1)?.createdAt ?? null,
  };
}
