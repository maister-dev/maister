import "server-only";

import { createHash } from "node:crypto";

import { and, eq, isNull, or } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  assertReviewDecision,
  isReviewSchema,
} from "@/lib/flows/hitl-validate";
import {
  compareThreadReplies,
  compareThreadRoots,
} from "@/lib/review-comments/order";
import {
  composeReworkPayload,
  type ComposeChatMessage,
  type ComposeRootComment,
  type ComposeThread,
} from "@/lib/review-comments/serialize";
import { readReviewSource, type ReviewSource } from "@/lib/runs/review-source";
import { resolveBaseRef } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  gateChatMessages,
  gateChatTurns,
  hitlRequests,
  projects,
  reviewComments,
  runs,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): this boundary accepts both a Drizzle database and its transaction.
type Db = any;

export const REVIEW_FEEDBACK_SUMMARY_MAX_LENGTH = 10_000;
const TOP_LEVEL_TEMPLATE_KEY_RE = /^[A-Za-z0-9_-]+$/;

export interface ReviewFeedbackTarget {
  nodeId: string;
  commentsVar: string;
}

export interface ReviewFeedbackPacket {
  fingerprint: string;
  target: ReviewFeedbackTarget;
  openThreadIds: string[];
  resolvedThreadCount: number;
  gateChatMessageCount: number;
  payload: string;
}

export interface ReviewFeedbackPreview {
  reviewSource: Pick<ReviewSource, "scope" | "baseCommit" | "fingerprint">;
  feedback: ReviewFeedbackPacket;
}

type ReviewGateRow = {
  id: string;
  runId: string;
  stepId: string;
  schema: unknown;
};

type ReviewCommentRow = ComposeRootComment & {
  parentId: string | null;
  status: "open" | "resolved";
};

type ReviewResponseInput = {
  summary: string;
  target: ReviewFeedbackTarget;
};

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaisterError("NEEDS_INPUT", message);
  }

  return value as Record<string, unknown>;
}

function deriveReviewResponseInput(
  schema: unknown,
  response: unknown,
): ReviewResponseInput {
  if (!isReviewSchema(schema)) {
    throw new MaisterError("PRECONDITION", "HITL request is not a review gate");
  }

  const resolved = assertReviewDecision(response, schema);

  if (!resolved.reworkTarget) {
    throw new MaisterError(
      "PRECONDITION",
      "feedback preview is available only for a rework decision",
    );
  }

  const schemaRecord = asRecord(schema, "review HITL schema is malformed");
  const commentsVar = schemaRecord.commentsVar;

  if (
    typeof commentsVar !== "string" ||
    !TOP_LEVEL_TEMPLATE_KEY_RE.test(commentsVar)
  ) {
    throw new MaisterError(
      "PRECONDITION",
      "review gate cannot prove a valid feedback template variable",
    );
  }

  const responseRecord = asRecord(
    response,
    "review response must be a JSON object",
  );
  const candidate =
    responseRecord[commentsVar] ?? responseRecord.comments ?? "";

  if (typeof candidate !== "string") {
    throw new MaisterError(
      "NEEDS_INPUT",
      `review feedback field "${commentsVar}" must be a string`,
    );
  }
  if (candidate.length > REVIEW_FEEDBACK_SUMMARY_MAX_LENGTH) {
    throw new MaisterError(
      "NEEDS_INPUT",
      `review feedback must be at most ${REVIEW_FEEDBACK_SUMMARY_MAX_LENGTH} characters`,
    );
  }

  return {
    summary: candidate,
    target: { nodeId: resolved.reworkTarget, commentsVar },
  };
}

export function reviewFeedbackFingerprint(input: {
  target: ReviewFeedbackTarget;
  openThreadIds: readonly string[];
  gateChatMessageCount: number;
  payload: string;
}): string {
  return sha256(
    JSON.stringify({
      target: input.target,
      openThreadIds: input.openThreadIds,
      gateChatMessageCount: input.gateChatMessageCount,
      payload: input.payload,
    }),
  );
}

async function loadReviewGate(
  db: Db,
  runId: string,
  hitlRequestId: string,
): Promise<ReviewGateRow> {
  const rows = (await db
    .select({
      id: hitlRequests.id,
      runId: hitlRequests.runId,
      stepId: hitlRequests.stepId,
      schema: hitlRequests.schema,
    })
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId))) as ReviewGateRow[];
  const gate = rows[0];

  if (!gate || gate.runId !== runId) {
    throw new MaisterError(
      "PRECONDITION",
      `review gate ${hitlRequestId} not found for run ${runId}`,
    );
  }

  return gate;
}

async function loadCompletedGateChatMessages(
  db: Db,
  hitlRequestId: string,
): Promise<ComposeChatMessage[]> {
  const rows = (await db
    .select({
      role: gateChatMessages.role,
      authorLabel: gateChatMessages.authorLabel,
      body: gateChatMessages.body,
    })
    .from(gateChatMessages)
    .leftJoin(
      gateChatTurns,
      or(
        eq(gateChatTurns.userMessageId, gateChatMessages.id),
        eq(gateChatTurns.agentMessageId, gateChatMessages.id),
      ),
    )
    .where(
      and(
        eq(gateChatMessages.hitlRequestId, hitlRequestId),
        or(isNull(gateChatTurns.id), eq(gateChatTurns.state, "completed")),
      ),
    )
    .orderBy(gateChatMessages.seq)) as ComposeChatMessage[];

  return rows;
}

async function loadReviewThreads(
  db: Db,
  runId: string,
): Promise<{ openThreads: ComposeThread[]; resolvedThreadCount: number }> {
  const rows = (await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.runId, runId))) as ReviewCommentRow[];
  const repliesByRoot = new Map<string, ReviewCommentRow[]>();

  for (const row of rows) {
    if (row.parentId === null) continue;
    const replies = repliesByRoot.get(row.parentId);

    if (replies) replies.push(row);
    else repliesByRoot.set(row.parentId, [row]);
  }

  const openThreads = rows
    .filter((row) => row.parentId === null && row.status === "open")
    .sort(compareThreadRoots)
    .map((root) => ({
      root,
      replies: (repliesByRoot.get(root.id) ?? []).sort(compareThreadReplies),
    }));

  return {
    openThreads,
    resolvedThreadCount: rows.filter(
      (row) => row.parentId === null && row.status === "resolved",
    ).length,
  };
}

async function readCurrentReviewSource(
  db: Db,
  runId: string,
): Promise<ReviewSource> {
  const [runRows, workspaceRows] = await Promise.all([
    db.select().from(runs).where(eq(runs.id, runId)),
    db.select().from(workspaces).where(eq(workspaces.runId, runId)),
  ]);
  const run = runRows[0];
  const workspace = workspaceRows[0];

  if (!run || !workspace || workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `review source is unavailable for run ${runId}`,
    );
  }
  if (run.runKind !== "flow") {
    throw new MaisterError(
      "PRECONDITION",
      "review feedback is available only for Flow runs",
    );
  }

  const projectRows = await db
    .select({ mainBranch: projects.mainBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const project = projectRows[0];

  if (!project) {
    throw new MaisterError(
      "PRECONDITION",
      `project not found for run ${runId}`,
    );
  }

  const baseCommit =
    workspace.baseCommit ??
    (await resolveBaseRef({
      worktreePath: workspace.worktreePath,
      branch: workspace.branch,
      mainBranch: project.mainBranch,
    }));

  return readReviewSource({
    worktreePath: workspace.worktreePath,
    baseCommit,
  });
}

export async function buildReviewFeedbackPacket(input: {
  db: Db;
  runId: string;
  hitlRequestId: string;
  response: unknown;
}): Promise<ReviewFeedbackPacket> {
  const gate = await loadReviewGate(input.db, input.runId, input.hitlRequestId);
  const reviewResponse = deriveReviewResponseInput(gate.schema, input.response);
  const [threadState, chatMessages] = await Promise.all([
    loadReviewThreads(input.db, input.runId),
    loadCompletedGateChatMessages(input.db, input.hitlRequestId),
  ]);
  const { openThreads, resolvedThreadCount } = threadState;
  const payload = composeReworkPayload(
    reviewResponse.summary,
    openThreads,
    chatMessages,
  );
  const openThreadIds = openThreads.map((thread) => thread.root.id);

  return {
    fingerprint: reviewFeedbackFingerprint({
      target: reviewResponse.target,
      openThreadIds,
      gateChatMessageCount: chatMessages.length,
      payload,
    }),
    target: reviewResponse.target,
    openThreadIds,
    resolvedThreadCount,
    gateChatMessageCount: chatMessages.length,
    payload,
  };
}

export async function buildReviewFeedbackPreview(input: {
  db: Db;
  runId: string;
  hitlRequestId: string;
  response: unknown;
}): Promise<ReviewFeedbackPreview> {
  const [reviewSource, feedback] = await Promise.all([
    readCurrentReviewSource(input.db, input.runId),
    buildReviewFeedbackPacket(input),
  ]);

  return {
    reviewSource: {
      scope: reviewSource.scope,
      baseCommit: reviewSource.baseCommit,
      fingerprint: reviewSource.fingerprint,
    },
    feedback,
  };
}

export function assertReviewFeedbackPresent(input: {
  packet: ReviewFeedbackPacket;
  schema: unknown;
  response: unknown;
}): void {
  const reviewResponse = deriveReviewResponseInput(
    input.schema,
    input.response,
  );

  if (
    reviewResponse.summary.trim().length > 0 ||
    input.packet.openThreadIds.length > 0
  ) {
    return;
  }

  throw new MaisterError(
    "NEEDS_INPUT",
    "requesting rework needs a feedback summary or an open review thread",
  );
}
