import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, count, desc, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { compareThreadReplies, compareThreadRoots } from "./order";

import {
  hitlRequests,
  nodeAttempts,
  reviewComments,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { isHumanReviewGate } from "@/lib/flows/review-gate";
import { PENDING_HITL_RUN_STATUS } from "@/lib/services/hitl";

export { compareThreadReplies, compareThreadRoots } from "./order";

// ADR-071 review-comment service: authz-free domain logic over the
// review_comments table. Routes own requireProjectAction + zod; this module
// owns the open-gate guard, thread integrity, and author rules. Every write is
// ONE DB transaction with no external side-effects, and runs.status is NEVER
// touched (the runner owns it).

const log = pino({
  name: "review-comments",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ReviewComment = typeof reviewComments.$inferSelect;

export interface ReviewCommentActor {
  userId: string;
  label: string;
}

export interface ReviewCommentThread {
  root: ReviewComment;
  replies: ReviewComment[];
}

export interface CreateRootInput {
  filePath: string;
  side: "old" | "new";
  line: number;
  lineContent: string;
  body: string;
}

export interface CreateReplyInput {
  parentId: string;
  body: string;
}

type Db = NodePgDatabase;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReviewGateRow = typeof hitlRequests.$inferSelect;

// Open-review-gate guard (allow-list, ADR-071): run exists, runs.status ∈
// PENDING_HITL_RUN_STATUS, and a pending kind=human hitl row whose stored
// schema declares review === true. Shared precondition for every write;
// otherwise 409 PRECONDITION at the route. Never a `!terminal` complement.
async function requireOpenReviewGate(
  tx: Tx,
  runId: string,
): Promise<ReviewGateRow> {
  const runRows = await tx.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }
  if (!PENDING_HITL_RUN_STATUS.has(run.status)) {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} has no open review gate (status: ${run.status})`,
    );
  }

  const pendingRows = await tx
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "human"),
        isNull(hitlRequests.respondedAt),
      ),
    )
    .orderBy(desc(hitlRequests.createdAt));
  const gate = pendingRows.find((row) => isHumanReviewGate(row));

  if (!gate) {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} has no pending review-gate hitl request`,
    );
  }

  log.debug(
    { runId, hitlRequestId: gate.id, nodeId: gate.stepId },
    "open review gate verified",
  );

  return gate;
}

// gateAttempt = 1-based visit number of the current gate (iteration tag).
// Prefer the server-stamped schema.gateAttempt (runner-side, ADR-071); until
// the runner stamps it, derive from the node_attempts count for
// (run_id, node_id) — the current visit's attempt row is appended BEFORE the
// gate parks at NeedsInput, so the count IS the visit number. Floored at 1
// (initial visit = 1) for rows without a ledger.
async function resolveGateAttempt(
  tx: Tx,
  runId: string,
  gate: ReviewGateRow,
): Promise<number> {
  const gateSchema = gate.schema;

  if (typeof gateSchema === "object" && gateSchema !== null) {
    // FIXME(any): hitlRequests.schema is jsonb→unknown; structural cast for
    // the gateAttempt read.
    const declared = (gateSchema as { gateAttempt?: unknown }).gateAttempt;

    if (
      typeof declared === "number" &&
      Number.isInteger(declared) &&
      declared >= 1
    ) {
      return declared;
    }
  }

  const rows = await tx
    .select({ value: count() })
    .from(nodeAttempts)
    .where(
      and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.nodeId, gate.stepId)),
    );

  return Math.max(1, Number(rows[0]?.value ?? 0));
}

// Cross-run or unknown commentId is not-found semantics (bare 404 at the
// route, per the ADR-071 identifiers table) — null, not a thrown error.
async function loadRunComment(
  tx: Tx,
  runId: string,
  commentId: string,
): Promise<ReviewComment | null> {
  const rows = await tx
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.id, commentId));
  const row = rows[0];

  if (!row || row.runId !== runId) return null;

  return row;
}

export async function createRoot(
  db: Db,
  actor: ReviewCommentActor,
  runId: string,
  input: CreateRootInput,
): Promise<ReviewComment> {
  return db.transaction(async (tx) => {
    const gate = await requireOpenReviewGate(tx, runId);
    const gateAttempt = await resolveGateAttempt(tx, runId, gate);

    const rows = await tx
      .insert(reviewComments)
      .values({
        runId,
        hitlRequestId: gate.id,
        nodeId: gate.stepId,
        gateAttempt,
        authorUserId: actor.userId,
        authorLabel: actor.label,
        filePath: input.filePath,
        side: input.side,
        line: input.line,
        lineContent: input.lineContent,
        body: input.body,
      })
      .returning();
    const created = rows[0];

    log.info(
      {
        runId,
        commentId: created.id,
        hitlRequestId: gate.id,
        nodeId: gate.stepId,
        gateAttempt,
        bodyLength: input.body.length,
      },
      "review comment thread created",
    );

    return created;
  });
}

export async function createReply(
  db: Db,
  actor: ReviewCommentActor,
  runId: string,
  input: CreateReplyInput,
): Promise<ReviewComment> {
  return db.transaction(async (tx) => {
    const gate = await requireOpenReviewGate(tx, runId);

    // parentId is body-controlled: it must resolve to a ROOT comment of the
    // SAME run (server-state compare) — 409 CONFLICT otherwise. Replying to a
    // RESOLVED root is allowed and never re-opens it.
    const parentRows = await tx
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, input.parentId));
    const parent = parentRows[0];

    if (!parent || parent.runId !== runId || parent.parentId !== null) {
      throw new MaisterError(
        "CONFLICT",
        `parentId must resolve to a root comment of run ${runId}`,
      );
    }

    const gateAttempt = await resolveGateAttempt(tx, runId, gate);

    const rows = await tx
      .insert(reviewComments)
      .values({
        runId,
        hitlRequestId: gate.id,
        nodeId: gate.stepId,
        gateAttempt,
        parentId: parent.id,
        authorUserId: actor.userId,
        authorLabel: actor.label,
        body: input.body,
      })
      .returning();
    const created = rows[0];

    log.info(
      {
        runId,
        commentId: created.id,
        threadId: parent.id,
        hitlRequestId: gate.id,
        gateAttempt,
        bodyLength: input.body.length,
      },
      "review comment reply created",
    );

    return created;
  });
}

export async function editBody(
  db: Db,
  actor: ReviewCommentActor,
  runId: string,
  commentId: string,
  body: string,
): Promise<ReviewComment | null> {
  return db.transaction(async (tx) => {
    await requireOpenReviewGate(tx, runId);

    const row = await loadRunComment(tx, runId, commentId);

    if (!row) return null;

    // A null author (deleted account) can never match a session user — the
    // comment is permanently un-editable, by design.
    if (row.authorUserId === null || row.authorUserId !== actor.userId) {
      throw new MaisterError(
        "UNAUTHORIZED",
        "only the comment author may edit it",
      );
    }

    const rows = await tx
      .update(reviewComments)
      .set({ body, updatedAt: new Date() })
      .where(eq(reviewComments.id, row.id))
      .returning();

    log.info(
      { runId, commentId: row.id, bodyLength: body.length },
      "review comment body edited",
    );

    // Empty RETURNING = the row was deleted by a concurrent transaction
    // between the in-tx SELECT and this UPDATE — not-found semantics.
    return rows[0] ?? null;
  });
}

export async function setStatus(
  db: Db,
  actor: ReviewCommentActor,
  runId: string,
  commentId: string,
  status: "open" | "resolved",
): Promise<ReviewComment | null> {
  return db.transaction(async (tx) => {
    await requireOpenReviewGate(tx, runId);

    const row = await loadRunComment(tx, runId, commentId);

    if (!row) return null;

    if (row.parentId !== null) {
      throw new MaisterError(
        "CONFLICT",
        "status is root-only: replies carry no own status",
      );
    }

    // Same-status set is an idempotent no-op: the first resolver wins and
    // retries never re-stamp resolution fields.
    if (row.status === status) {
      log.debug({ runId, commentId: row.id, status }, "status no-op");

      return row;
    }

    const patch =
      status === "resolved"
        ? {
            status,
            resolvedByUserId: actor.userId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          }
        : {
            status,
            resolvedByUserId: null,
            resolvedAt: null,
            updatedAt: new Date(),
          };

    const rows = await tx
      .update(reviewComments)
      .set(patch)
      .where(eq(reviewComments.id, row.id))
      .returning();

    log.info(
      { runId, commentId: row.id, status },
      status === "resolved"
        ? "review thread resolved"
        : "review thread re-opened",
    );

    // Empty RETURNING = the row was deleted by a concurrent transaction
    // between the in-tx SELECT and this UPDATE — not-found semantics.
    return rows[0] ?? null;
  });
}

export async function remove(
  db: Db,
  actor: ReviewCommentActor,
  runId: string,
  commentId: string,
): Promise<ReviewComment | null> {
  return db.transaction(async (tx) => {
    await requireOpenReviewGate(tx, runId);

    const row = await loadRunComment(tx, runId, commentId);

    if (!row) return null;

    if (row.authorUserId === null || row.authorUserId !== actor.userId) {
      throw new MaisterError(
        "UNAUTHORIZED",
        "only the comment author may delete it",
      );
    }

    // A root delete cascades its replies through the parent_id FK.
    await tx.delete(reviewComments).where(eq(reviewComments.id, row.id));

    log.info(
      { runId, commentId: row.id, isRoot: row.parentId === null },
      "review comment deleted",
    );

    return row;
  });
}

// Read path — NO gate guard (history stays visible like the diff, any run
// status). One query for the run's comments; threads are assembled in memory.
// Placement is NOT computed here (the anchor lib owns it at the route).
export async function listThreads(
  db: Db,
  runId: string,
): Promise<ReviewCommentThread[]> {
  const rows = await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.runId, runId));

  const repliesByRoot = new Map<string, ReviewComment[]>();

  for (const row of rows) {
    if (row.parentId === null) continue;

    const bucket = repliesByRoot.get(row.parentId);

    if (bucket) {
      bucket.push(row);
    } else {
      repliesByRoot.set(row.parentId, [row]);
    }
  }
  for (const bucket of repliesByRoot.values()) {
    bucket.sort(compareThreadReplies);
  }

  const threads = rows
    .filter((row) => row.parentId === null)
    .sort(compareThreadRoots)
    .map((root) => ({ root, replies: repliesByRoot.get(root.id) ?? [] }));

  log.debug(
    { runId, threadCount: threads.length, commentCount: rows.length },
    "listed review comment threads",
  );

  return threads;
}
