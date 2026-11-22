import "server-only";

import type {
  ReviewDecision,
  ReviewSelector,
} from "./knowledge-memory-reviews";
import type { AgentMemoryMutation } from "@/lib/agent-memory-vault/commands";
import type { VaultRevision } from "@/lib/agent-memory-vault/store";
import type { AgentMemoryProposedChange } from "@/lib/agent-memory-vault/types";
import type { BrainProposalDto } from "@/lib/brain/proposals";
import type { KnowledgeProposalView } from "@/lib/brain/knowledge-proposal-read";
import type { Db } from "@/lib/execution-host/db";
import type { PersonalKnowledgeCredential } from "@/lib/tokens/personal-knowledge";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { canonicalCommandJson } from "../../../runtime/command-json";

import {
  brainReviewActions,
  readProposalReviewMetadata,
} from "./knowledge-memory-reviews";

import { lockVaultSources } from "@/lib/agent-memory-vault/source-redaction-fence";
import {
  insertMemoryText,
  replaceMemoryText,
} from "@/lib/agent-memory-vault/commands";
import { MAX_VAULT_NOTE_COUNT } from "@/lib/agent-memory-vault/limits";
import {
  decideVaultProposalInTransaction,
  lockVaultReview,
  readVaultReviewHistory,
  readVaultProposalCommand,
} from "@/lib/agent-memory-vault/review";
import {
  readVaultPayload,
  unavailableMemory,
} from "@/lib/agent-memory-vault/store";
import { projectRolesForActions } from "@/lib/authz";
import { resolveKnowledgePrincipal } from "@/lib/brain/knowledge-access";
import { lockKnowledgeWriteConsumer } from "@/lib/brain/knowledge-disclosure";
import { getKnowledgeProposal } from "@/lib/brain/knowledge-proposal-read";
import { reviewKnowledgeProposal } from "@/lib/brain/knowledge-proposals";
import { getKnowledgeWitnessContent } from "@/lib/brain/knowledge-witnesses";
import { concludeBrainProposal, getBrainProposal } from "@/lib/brain/proposals";
import { readBrainProposalDraftContent } from "@/lib/brain/projection";
import { inboxReviewReceipts as receipts } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";
import { truncateUtf16 } from "@/lib/utf8";

const log = pino({
  name: "inbox-proposal-review",
  level: process.env.LOG_LEVEL ?? "info",
});
const previewNamespace = "maister.inbox.review-preview.v1";
const outcomeNamespace = "maister.inbox.vault-review-outcome.v1";
const outcomePageSize = 20;
const previewPageChars = 262_144;
const previewCursorSchema = z.strictObject({
  scope: z.string().length(64),
  index: z
    .int()
    .min(0)
    .max(MAX_VAULT_NOTE_COUNT - 1),
  offset: z.int().min(0),
});
const outcomeCursorSchema = z.strictObject({
  scope: z.string().length(64),
  offset: z
    .int()
    .min(1)
    .max(MAX_VAULT_NOTE_COUNT - 1),
});
const boundedCursor = z.string().min(1).max(2048).optional();
const reviewContinuationSchema = z.strictObject({
  cursor: boundedCursor,
  outcomeCursor: boundedCursor,
});

type ReviewAudience = Readonly<{ userId: string; tokenId?: string }>;
type ReviewContinuations = z.infer<typeof reviewContinuationSchema>;

export function parseReviewContinuations(
  request: Request,
): ReviewContinuations {
  const params = new URL(request.url).searchParams;
  const parsed = reviewContinuationSchema.safeParse(Object.fromEntries(params));

  if (!parsed.success || params.size !== new Set(params.keys()).size)
    throw new MaisterError("CONFIG", "Invalid review continuation");

  return parsed.data;
}

const emptyDecision = {
  by: null,
  at: null,
  reason: null,
  reviewedVersion: null,
};

function rejectedOutcome(selection: ReviewSelector) {
  return {
    type: "rejected" as const,
    proposalId: selection.id,
    href: reviewHref(selection),
  };
}

function reviewHref({ kind, id }: ReviewSelector) {
  return `/inbox?${new URLSearchParams({ kind, proposalId: id })}#knowledge-memory`;
}

function dateString(value: Date | string | null) {
  return value === null ? null : new Date(value).toISOString();
}

type Result = Readonly<{
  status: "applied" | "rejected" | "conflict" | "unavailable" | "refused";
  replayed: boolean;
  receiptId: string | null;
  domainState?: string;
  outcome?: DecisionDisposition["outcome"];
}>;

function projectKnowledgeOutcome(proposal: KnowledgeProposalView) {
  if (proposal.status === "rejected")
    return rejectedOutcome({ kind: "knowledge", id: proposal.id });
  if (!proposal.acceptedRecordId || !proposal.acceptedRecordRevision)
    return null;

  return {
    type: "published_revision" as const,
    recordId: proposal.acceptedRecordId,
    revision: proposal.acceptedRecordRevision,
    href: `/knowledge/${encodeURIComponent(proposal.acceptedRecordId)}?revision=${proposal.acceptedRecordRevision}`,
  };
}

function projectVaultOutcome(
  {
    proposal,
    locationId,
    applied,
    enabled,
  }: Awaited<ReturnType<typeof lockVaultReview>>,
  audience: ReviewAudience,
  rawCursor?: string,
) {
  if (rawCursor && (!locationId || !proposal.appliedOperationId))
    throw new MaisterError(
      "CONFIG",
      "Review has no applied revision continuation",
    );
  if (proposal.state === "rejected")
    return rejectedOutcome({ kind: "vault", id: proposal.id });
  if (!proposal.appliedOperationId) return null;
  const scope = reviewCursorScope(
    { kind: "vault", id: proposal.id },
    audience,
    proposal.version,
    proposal.appliedOperationId,
  );
  const decoded = rawCursor
    ? outcomeCursorSchema.safeParse(
        parseCursorPayload(outcomeNamespace, rawCursor),
      ).data
    : { scope, offset: 0 };

  if (
    !decoded ||
    decoded.scope !== scope ||
    (rawCursor && decoded.offset >= applied.length)
  )
    throw new MaisterError(
      "CONFIG",
      "Invalid vault review outcome continuation",
    );

  const end = decoded.offset + outcomePageSize;
  const href = (noteId: string, revisionId: string) =>
    enabled && locationId
      ? `/knowledge/memory?${new URLSearchParams({
          locationId,
          memoryRevision: revisionId,
          memoryNoteId: noteId,
        })}`
      : null;
  const revisions = locationId
    ? applied.slice(decoded.offset, end).map(({ id, noteId, path }) => ({
        noteId,
        revisionId: id,
        path,
        href: href(noteId, id),
      }))
    : [];
  const first = applied.at(0);

  return {
    type: "applied_vault_operation" as const,
    operationId: proposal.appliedOperationId,
    href:
      enabled && locationId
        ? first
          ? href(first.noteId, first.id)
          : `/knowledge/memory?${new URLSearchParams({ locationId })}`
        : null,
    revisionCount: applied.length,
    revisions,
    revisionsNextCursor:
      locationId && end < applied.length
        ? signCursorPayload(outcomeNamespace, { scope, offset: end })
        : null,
  };
}

async function isVaultPromotion(tx: Db, proposalId: string): Promise<boolean> {
  const { rows } = await tx.execute(
    sql`SELECT 1 FROM agent_memory_promotions WHERE proposal_id=${proposalId}`,
  );

  return rows.length > 0;
}

function sharedTx(tx: Db) {
  return {
    execute: tx.execute.bind(tx),
    transaction: async <T>(work: (handle: Db) => Promise<T>) => work(tx),
  };
}

function markPatchLines(content: string, marker: string): string {
  return content ? `${marker}${content.replaceAll("\n", `\n${marker}`)}` : "";
}

async function renderVaultPatch(
  tx: Db,
  command: AgentMemoryMutation,
  change: AgentMemoryProposedChange,
  bases: ReadonlyMap<string, VaultRevision>,
): Promise<string> {
  const base =
    change.beforeRevisionId === null
      ? undefined
      : bases.get(change.beforeRevisionId);

  if (change.beforeRevisionId !== null && !base) throw unavailableMemory();
  const before = base?.contentSha256 ? await readVaultPayload(tx, base) : "";
  let after = "";

  if (command.command === "create") after = command.file_text;
  if (command.command === "rename") after = before;
  if (command.command === "insert")
    after = insertMemoryText(before, command.insert_line, command.insert_text);
  if (command.command === "str_replace")
    after = replaceMemoryText(before, command.old_str, command.new_str);
  if (command.command === "revert") {
    const target = bases.get(command.revisionId);

    if (!target) throw unavailableMemory();
    after = await readVaultPayload(tx, target);
  }

  return [
    `--- ${base?.path ?? "/dev/null"}`,
    `+++ ${change.kind === "deleted" ? "/dev/null" : change.path}`,
    markPatchLines(before, "-"),
    markPatchLines(after, "+"),
  ].join("\n");
}

function reviewCursorScope(
  selection: ReviewSelector,
  audience: ReviewAudience,
  revision: string | number,
  snapshot: string,
): string {
  return createHash("sha256")
    .update(
      canonicalCommandJson([
        audience.userId,
        selection.kind,
        selection.id,
        revision,
        snapshot,
        ...(audience.tokenId ? [audience.tokenId] : []),
      ]),
    )
    .digest("hex");
}

async function pageReviewText(
  scope: string,
  blockCount: number,
  renderBlock: (index: number) => Promise<string> | string,
  rawCursor?: string,
): Promise<{ summary: string; nextCursor: string | null }> {
  const cursor =
    rawCursor === undefined
      ? { scope, index: 0, offset: 0 }
      : previewCursorSchema.safeParse(
          parseCursorPayload(previewNamespace, rawCursor),
        ).data;

  if (!cursor || cursor.scope !== scope || cursor.index >= blockCount)
    throw new MaisterError("CONFIG", "Invalid proposal review continuation");
  const fragments: string[] = [];
  let remaining = previewPageChars;
  let { index, offset } = cursor;

  while (index < blockCount && remaining > 0) {
    const block = await renderBlock(index);

    if (offset > block.length)
      throw new MaisterError(
        "CONFIG",
        "Invalid proposal review continuation offset",
      );
    const fragment = truncateUtf16(
      block.slice(offset, offset + remaining + 1),
      remaining,
    );

    fragments.push(fragment);
    remaining -= fragment.length;
    offset += fragment.length;
    if (offset < block.length) break;
    index += 1;
    offset = 0;
  }
  const nextCursor =
    index < blockCount
      ? signCursorPayload(previewNamespace, { scope, index, offset })
      : null;

  return { summary: fragments.join(""), nextCursor };
}

async function vaultPreview(
  tx: Db,
  selection: ReviewSelector,
  audience: ReviewAudience,
  { cursor, outcomeCursor }: ReviewContinuations,
  domainState: string,
) {
  const review =
    domainState === "pending"
      ? await lockVaultReview(tx, selection.id, audience.userId)
      : await readVaultReviewHistory(tx, selection.id, audience.userId);

  const { proposal, bases, locationId } = review;

  if (proposal.state !== domainState)
    throw new MaisterError("CONFLICT", "Review changed while opening");
  const scope = reviewCursorScope(
    selection,
    audience,
    proposal.version,
    proposal.operationId,
  );
  const command = await readVaultProposalCommand(tx, proposal);
  const baseById = new Map(bases.map((revision) => [revision.id, revision]));
  const page = await pageReviewText(
    scope,
    proposal.changes.length,
    async (index) =>
      (await renderVaultPatch(
        tx,
        command,
        proposal.changes[index]!,
        baseById,
      )) + (index + 1 < proposal.changes.length ? "\n" : ""),
    cursor,
  );

  return {
    ...page,
    sourceRevisionId: bases.at(0)?.id ?? null,
    detail: {
      operationId: proposal.operationId,
      changeCount: proposal.changes.length,
      vaultHref: locationId
        ? `/knowledge/memory?${new URLSearchParams({ locationId })}`
        : null,
    },
    decision: {
      by: proposal.reviewerId,
      at: dateString(proposal.decidedAt),
      reason: proposal.decisionReason,
      reviewedVersion:
        proposal.version > 1 ? String(proposal.version - 1) : null,
    },
    outcome: projectVaultOutcome(review, audience, outcomeCursor),
  };
}

async function brainOutcome(
  tx: Db,
  selection: ReviewSelector,
  proposal: BrainProposalDto,
  promoted: boolean,
) {
  if (proposal.status === "rejected") return rejectedOutcome(selection);
  if (proposal.status === "accepted" && promoted)
    return {
      type: "accepted_proposal" as const,
      proposalId: proposal.id,
      href: reviewHref(selection),
    };

  if (proposal.taskId) {
    const [task] = (
      await tx.execute<{ slug: string; number: number }>(sql`
      SELECT p.slug,t.number FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.id=${proposal.taskId} AND t.project_id=${proposal.projectId} AND p.archived_at IS NULL
    `)
    ).rows;

    if (task)
      return {
        type: "project_task" as const,
        taskId: proposal.taskId,
        href: `/projects/${encodeURIComponent(task.slug)}/tasks/${task.number}`,
      };
  }

  if (proposal.authoredDraftId) {
    const [draft] = (
      await tx.execute<{ slug: string; kind: string }>(sql`
      SELECT p.slug,cap.kind FROM authored_capabilities cap
      JOIN projects p ON p.id=cap.project_id AND p.archived_at IS NULL
      WHERE cap.id=${proposal.authoredDraftId} AND cap.project_id=${proposal.projectId}
        AND cap.archived_at IS NULL
    `)
    ).rows;

    return {
      type: "catalog_draft" as const,
      draftId: proposal.authoredDraftId,
      href: draft
        ? draft.kind === "flow"
          ? `/flows/${encodeURIComponent(draft.slug)}/${encodeURIComponent(proposal.authoredDraftId)}`
          : `/projects/${encodeURIComponent(draft.slug)}/brain/proposals/${encodeURIComponent(proposal.id)}/draft`
        : null,
    };
  }

  return null;
}

function brainDraftPreview(proposal: BrainProposalDto) {
  const { draft } = proposal;
  const draftPath = typeof draft.path === "string" ? draft.path : null;
  const body = draft.body;
  const flowYaml =
    body && typeof body === "object" && "flowYaml" in body
      ? body.flowYaml
      : null;

  if (proposal.kind === "flow") {
    if (typeof flowYaml === "string")
      return { content: flowYaml, contentFormat: "yaml" as const, draftPath };
    if (draft.manifest && typeof draft.manifest === "object")
      return {
        content: stringifyYaml(draft.manifest),
        contentFormat: "yaml" as const,
        draftPath,
      };
  }
  const markdown = readBrainProposalDraftContent(draft);

  return markdown === null
    ? {
        content: JSON.stringify(draft, null, 2),
        contentFormat: "text" as const,
        draftPath,
      }
    : { content: markdown, contentFormat: "markdown" as const, draftPath };
}

export async function getProposalReviewDetail(
  db: Db,
  userId: string,
  selection: ReviewSelector,
  options: ReviewContinuations & {
    credential?: PersonalKnowledgeCredential;
  } = {},
) {
  const { cursor, outcomeCursor, credential } = options;
  const audience = { userId, tokenId: credential?.tokenId };

  return db.transaction(async (tx) => {
    if (selection.kind === "vault") await lockVaultSources(tx);
    const {
      projectId,
      createdAt: _createdAt,
      ...item
    } = await readProposalReviewMetadata(tx, userId, selection, credential);
    const principal = { kind: "user", userId } as const;

    if (outcomeCursor && selection.kind !== "vault")
      throw new MaisterError(
        "CONFIG",
        "Only vault reviews have result continuations",
      );

    if (selection.kind === "knowledge") {
      if (cursor !== undefined)
        throw new MaisterError(
          "CONFIG",
          "Knowledge reviews do not have continuation pages",
        );
      const proposal = await getKnowledgeProposal(
        sharedTx(tx),
        principal,
        selection.id,
        { historyRead: true },
      );

      if (
        String(proposal.revision) !== item.version ||
        proposal.status !== item.domainState
      )
        throw new MaisterError("CONFLICT", "Review changed while opening");
      const proposalHref = `/knowledge/proposals/${encodeURIComponent(proposal.id)}`;
      const sourceHref =
        proposal.content.change === "correct"
          ? `/knowledge/${encodeURIComponent(proposal.content.recordId)}?revision=${proposal.content.expectedRevision}`
          : null;

      return {
        ...item,
        kind: "knowledge" as const,
        createdAt: _createdAt,
        detail: {
          proposalRevision: proposal.revision,
          baseRevision:
            proposal.content.change === "correct"
              ? proposal.content.expectedRevision
              : null,
          proposalHref,
          sourceHref,
        },
        decision: proposal.decision ?? emptyDecision,
        outcome: projectKnowledgeOutcome(proposal),
        summary: proposal.content.assertion,
        sourceRevisionId: null,
        nextCursor: null,
      };
    }
    if (selection.kind === "vault") {
      const page = await vaultPreview(
        tx,
        selection,
        audience,
        options,
        item.domainState,
      );

      log.debug(
        {
          kind: selection.kind,
          continued: Boolean(cursor),
          continuedOutcome: Boolean(outcomeCursor),
          complete: page.nextCursor === null,
        },
        "proposal review detail read",
      );

      return {
        ...item,
        kind: "vault" as const,
        createdAt: _createdAt,
        ...page,
      };
    } else {
      if (!projectId) throw unavailableMemory();
      const {
        rows: [head],
      } = await tx.execute<{ version: string }>(sql`
        SELECT updated_at::text AS version FROM brain_proposals
        WHERE project_id=${projectId} AND id=${selection.id} FOR SHARE
      `);

      if (head?.version !== item.version)
        throw new MaisterError("CONFLICT", "Review changed while opening");
      const proposal = await getBrainProposal(tx, projectId, selection.id, {
        type: "user",
        id: userId,
      });

      const witnessId = proposal.draft.witnessId;
      const promoted = await isVaultPromotion(tx, proposal.id);

      if (promoted && typeof witnessId !== "string") throw unavailableMemory();
      const preview =
        promoted && typeof witnessId === "string"
          ? {
              content: await getKnowledgeWitnessContent(
                sharedTx(tx),
                principal,
                witnessId,
              ),
              contentFormat: "markdown" as const,
              draftPath: null,
            }
          : brainDraftPreview(proposal);
      const { content, contentFormat, draftPath } = preview;
      const digest = createHash("sha256").update(content).digest("hex");
      const scope = reviewCursorScope(
        selection,
        audience,
        item.version,
        digest,
      );

      const page = {
        ...(await pageReviewText(scope, 1, () => content, cursor)),
        sourceRevisionId: null,
      };
      const expectedEffect = promoted
        ? ("accepted_proposal" as const)
        : brainReviewActions(proposal.kind, "accept").includes("manageCatalog")
          ? ("catalog_draft" as const)
          : ("project_task" as const);
      const outcome = await brainOutcome(tx, selection, proposal, promoted);

      log.debug(
        {
          kind: selection.kind,
          continued: Boolean(cursor),
          complete: page.nextCursor === null,
        },
        "proposal review detail read",
      );

      return {
        ...item,
        kind: "brain" as const,
        createdAt: _createdAt,
        ...page,
        detail: {
          proposalKind: proposal.kind,
          origin: promoted
            ? ("vault_promotion" as const)
            : ("ordinary" as const),
          expectedEffect,
          contentFormat,
          draftPath,
          sourceHref:
            promoted && typeof witnessId === "string"
              ? `/knowledge/witnesses/${encodeURIComponent(witnessId)}`
              : null,
        },
        decision: {
          by: proposal.resolution?.actor.id ?? null,
          at: dateString(proposal.resolvedAt),
          reason: proposal.resolution?.reason ?? null,
          reviewedVersion: proposal.resolution?.reviewedVersion ?? null,
        },
        outcome,
      };
    }
  });
}

async function authorizeBrainDecision(
  tx: Db,
  userId: string,
  item: ReviewDecision,
) {
  const actor = await resolveKnowledgePrincipal(
    tx,
    { kind: "user", userId },
    "knowledge:review",
  );

  if (actor.kind !== "user") throw unavailableMemory();
  const [head] = (
    await tx.execute<{
      id: string;
      slug: string;
      kind: BrainProposalDto["kind"];
    }>(sql`
    SELECT p.id,p.slug,b.kind FROM projects p JOIN brain_proposals b ON b.project_id=p.id
    WHERE b.id=${item.id} AND p.archived_at IS NULL
      AND b.kind NOT IN ('knowledge_add','knowledge_correct') FOR SHARE OF p
  `)
  ).rows;

  if (!head) throw unavailableMemory();

  if (actor.user.role !== "admin") {
    const actions = brainReviewActions(head.kind, item.decision);
    const roles = sql.join(
      projectRolesForActions(actions).map((role) => sql`${role}`),
      sql`, `,
    );
    const result = await tx.execute(sql`SELECT 1 FROM project_members
      WHERE user_id=${userId} AND project_id=${head.id} AND role IN (${roles}) FOR SHARE`);

    if (!result.rows.length) throw unavailableMemory();
  }

  return head;
}

function approvalVersion(input: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(input) || Number(input) > 2147483647)
    throw new MaisterError("CONFIG", "Invalid numeric proposal version");

  return Number(input);
}

type DecisionDisposition = Readonly<{
  domainState: string;
  outcome: NonNullable<
    | ReturnType<typeof projectVaultOutcome>
    | ReturnType<typeof projectKnowledgeOutcome>
    | Awaited<ReturnType<typeof brainOutcome>>
  >;
}>;

async function readDecisionDisposition(
  tx: Db,
  audience: ReviewAudience,
  item: ReviewDecision,
  projectId?: string,
): Promise<DecisionDisposition> {
  const { userId } = audience;

  if (item.kind === "vault") {
    const review = await lockVaultReview(tx, item.id, userId);
    const outcome = projectVaultOutcome(review, audience);

    if (outcome) return { domainState: review.proposal.state, outcome };
  } else if (item.kind === "knowledge") {
    const proposal = await getKnowledgeProposal(
      sharedTx(tx),
      { kind: "user", userId },
      item.id,
    );
    const outcome = projectKnowledgeOutcome(proposal);

    if (outcome) return { domainState: proposal.status, outcome };
  } else if (projectId) {
    const proposal = await getBrainProposal(tx, projectId, item.id, {
      type: "user",
      id: userId,
    });
    const outcome = await brainOutcome(
      tx,
      item,
      proposal,
      await isVaultPromotion(tx, proposal.id),
    );

    if (outcome) return { domainState: proposal.status, outcome };
  }

  throw new MaisterError("CONFLICT", "Review outcome is currently unavailable");
}

type ReviewReceipt = DecisionDisposition &
  Readonly<{
    status: "applied" | "rejected";
    receiptId: string;
    replayed: boolean;
  }>;

async function settle(
  tx: Db,
  userId: string,
  item: ReviewDecision,
  credential?: PersonalKnowledgeCredential,
): Promise<ReviewReceipt> {
  if (item.kind === "vault") await lockVaultSources(tx);
  if (credential)
    await readProposalReviewMetadata(
      tx,
      userId,
      item,
      credential,
      "decisions:review",
    );
  const digest = createHash("sha256")
    .update(canonicalCommandJson(item))
    .digest("hex");

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["inbox-review", userId, item.requestKey])},0))`,
  );
  const [prior] = await tx
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.userId, userId),
        eq(receipts.requestKey, item.requestKey),
      ),
    );
  const principal = { kind: "user", userId } as const;
  const audience = { userId, tokenId: credential?.tokenId };
  const state = item.decision === "accept" ? "applied" : "rejected";
  const brain =
    item.kind === "brain"
      ? await authorizeBrainDecision(tx, userId, item)
      : null;

  if (item.kind === "vault" && prior)
    await lockVaultReview(tx, item.id, userId);
  if (item.kind === "knowledge") {
    await lockKnowledgeWriteConsumer(tx, principal);
    const proposal = await getKnowledgeProposal(
      sharedTx(tx),
      principal,
      item.id,
    );

    if (prior && proposal.status === "pending")
      throw new MaisterError(
        "CONFLICT",
        "Review receipt does not match a settled knowledge proposal",
      );
  }

  if (prior && prior.digest !== digest)
    throw new MaisterError(
      "CONFLICT",
      "Review request key already belongs to another decision",
    );
  if (item.kind === "knowledge") {
    const decision = await reviewKnowledgeProposal(sharedTx(tx), {
      principal,
      proposalId: item.id,
      expectedRevision: approvalVersion(item.expectedVersion),
      decision: item.decision,
      reason: item.reason ?? "",
      idempotencyKey: item.requestKey,
    });

    if (decision.duplicate && !prior)
      throw new MaisterError(
        "CONFLICT",
        "Knowledge proposal already has a native decision",
      );
  }

  if (prior) {
    return {
      ...(await readDecisionDisposition(tx, audience, item, brain?.id)),
      status: state,
      receiptId: prior.id,
      replayed: true,
    };
  }
  if (item.kind === "vault")
    await decideVaultProposalInTransaction(tx, {
      userId,
      proposalId: item.id,
      decision: item.decision,
      expectedVersion: approvalVersion(item.expectedVersion),
      requestKey: item.requestKey,
      reason: item.reason,
    });
  if (brain)
    await concludeBrainProposal(sharedTx(tx), {
      projectId: brain.id,
      projectSlug: brain.slug,
      proposalId: item.id,
      actor: { type: "user", id: userId },
      action: item.decision,
      reason: item.reason,
      expectedVersion: item.expectedVersion,
    });
  const [record] = await tx
    .insert(receipts)
    .values({ userId, requestKey: item.requestKey, digest })
    .returning({ id: receipts.id });

  if (!record)
    throw new MaisterError("CRASH", "Inbox review receipt was not stored");

  return {
    ...(await readDecisionDisposition(tx, audience, item, brain?.id)),
    status: state,
    receiptId: record.id,
    replayed: false,
  };
}

export async function decideProposalReview(
  db: Db,
  userId: string,
  item: ReviewDecision,
  credential?: PersonalKnowledgeCredential,
) {
  const { status, ...receipt } = await db.transaction((tx) =>
    settle(tx, userId, item, credential),
  );

  log.info(
    {
      kind: item.kind,
      status,
      receiptId: receipt.receiptId,
      replayed: receipt.replayed,
    },
    "proposal decision settled",
  );

  return {
    kind: item.kind,
    id: item.id,
    reviewedVersion: item.expectedVersion,
    ...receipt,
  };
}

export async function decideProposalReviewBatch(
  db: Db,
  userId: string,
  items: readonly ReviewDecision[],
) {
  const results: Result[] = [];

  for (const item of items) {
    try {
      results.push(await db.transaction((tx) => settle(tx, userId, item)));
    } catch (error) {
      const code = isMaisterError(error) ? error.code : "CRASH";
      const status =
        code === "CONFLICT"
          ? "conflict"
          : code === "PRECONDITION" || code === "UNAUTHORIZED"
            ? "unavailable"
            : "refused";

      log.warn({ kind: item.kind, code }, "Inbox proposal decision refused");
      results.push({ status, replayed: false, receiptId: null });
    }
  }
  log.info(
    {
      userId,
      items: items.length,
      settled: results.filter(({ receiptId }) => receiptId !== null).length,
    },
    "Inbox proposal batch settled",
  );

  return { results };
}
