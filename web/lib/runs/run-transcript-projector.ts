import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { TranscriptMessage } from "@/components/run-transcript/transcript-view";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { projectExecutionEvents } from "@/lib/execution-host/events/projector";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";
import { projectTranscriptEvent } from "@/lib/execution-host/events/transcript-projector";
import { prepareTranscriptContent } from "@/lib/execution-host/events/session-content";

const { runMessages, runs } = schema;

type DbClient = NodePgDatabase<typeof schema>;

function db(): DbClient {
  return getDb();
}

export type ProjectRunTranscriptResult = {
  status: "projected" | "missing-run" | "missing-events" | "unchanged";
  nodeAttempts: number;
  rowsUpserted: number;
};

// Reads may help with one bounded quantum. The autonomous worker owns eventual
// catch-up, including when no reader or new event arrives after a restart.
async function projectCanonicalRunTranscript(
  runId: string,
  client: DbClient,
): Promise<ProjectRunTranscriptResult> {
  const attempts = new Set<string>();
  let changed = 0;
  const summary = await projectExecutionEvents({
    db: client,
    runId,
    projector: {
      consumerName: CANONICAL_PROJECTION_CONSUMERS.transcript,
      prepare: prepareTranscriptContent,
      project: async (tx, event) => {
        if (await projectTranscriptEvent(tx, event)) {
          changed += 1;
          const attemptId = event.payload?.nodeAttemptId;

          if (typeof attemptId === "string") attempts.add(attemptId);
        }
      },
    },
  });

  if (summary.poisoned) {
    throw new MaisterError(
      "CONFLICT",
      "canonical transcript projection requires repair",
      {
        details: { reason: "transcript_projection_poisoned", runId },
      },
    );
  }
  const rowsUpserted = summary.projected > 0 ? changed : 0;

  return {
    status:
      rowsUpserted > 0
        ? "projected"
        : summary.lastRunSequence === null
          ? "missing-events"
          : "unchanged",
    nodeAttempts: rowsUpserted > 0 ? attempts.size : 0,
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
    // EDGE-TRC-08. Order on the run's EVENT stream, not on the order the two
    // writers arrived. Both store their stream position in the same column:
    // the projector writes the event it came FROM, the dispatcher the horizon
    // it was issued AFTER. Ordering on `sequence` alone reads a node with a
    // blocking gate as `node prompt, gate prompt, node reply, gate reply`
    // whenever the reply is still unprojected at the gate's dispatch — which
    // is the normal case, since the runner drives only the artifact projector.
    //
    // The middle term breaks an exact tie: a prompt anchored at E was issued
    // AFTER the event E, so it must follow the reply projected FROM E. Within
    // one horizon several prompts fall back to `sequence`, their dispatch
    // order. Every row in a node transcript carries a position, so the
    // coalesce is defensive only.
    .orderBy(
      sql`coalesce(${runMessages.supervisorEventId}, '0')::bigint asc`,
      sql`(${runMessages.promptDispatchKey} is not null) asc`,
      asc(runMessages.sequence),
    );

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

/**
 * TRC-11. `includeRecordedPrompts` defaults to FALSE — a dispatcher-recorded
 * prompt is withheld unless a caller asks for it by name.
 *
 * The default is inverted deliberately. This feed is the FALLBACK the external
 * `runs:read` activity seam takes when its own filtered query returns no rows,
 * which is exactly the state of a flow run whose only rows so far ARE its
 * prompts. A filter applied at that one call site would have left the next
 * caller to rediscover the problem; refusing by default means forgetting is
 * safe and remembering is explicit.
 */
export async function getWholeRunTranscriptMessages(
  runId: string,
  opts: {
    client?: DbClient;
    runtimeRoot?: string;
    includeRecordedPrompts?: boolean;
  } = {},
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
    .where(
      opts.includeRecordedPrompts
        ? eq(runMessages.runId, runId)
        : and(
            eq(runMessages.runId, runId),
            isNull(runMessages.promptDispatchKey),
          ),
    )
    // Left on arrival order on purpose: this feed serves scratch and agent
    // runs, whose `user` rows carry no stream position, so the EDGE-TRC-08
    // ordering used by the node transcript would sort them all to the front.
    // With prompts excluded by default there is nothing here to re-order.
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
