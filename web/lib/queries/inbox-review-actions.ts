import "server-only";

import type {
  ReviewDecision,
  ReviewSelector,
} from "./knowledge-memory-reviews";
import type { AgentMemoryMutation } from "@/lib/agent-memory-vault/commands";
import type { VaultRevision } from "@/lib/agent-memory-vault/store";
import type { AgentMemoryProposedChange } from "@/lib/agent-memory-vault/types";
import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { readProposalReviewMetadata } from "./knowledge-memory-reviews";

import {
  insertMemoryText,
  replaceMemoryText,
} from "@/lib/agent-memory-vault/commands";
import { MAX_VAULT_NOTE_COUNT } from "@/lib/agent-memory-vault/limits";
import {
  decideVaultProposalInTransaction,
  lockVaultReview,
  readVaultProposalCommand,
} from "@/lib/agent-memory-vault/review";
import {
  readVaultPayload,
  unavailableMemory,
} from "@/lib/agent-memory-vault/store";
import { projectRolesForActions } from "@/lib/authz";
import {
  authorizeKnowledge,
  resolveKnowledgePrincipal,
} from "@/lib/brain/knowledge-access";
import { lockKnowledgeWriteConsumer } from "@/lib/brain/knowledge-disclosure";
import { getKnowledgeProposal } from "@/lib/brain/knowledge-proposal-read";
import { reviewKnowledgeProposal } from "@/lib/brain/knowledge-proposals";
import { getKnowledgeWitnessContent } from "@/lib/brain/knowledge-witnesses";
import { concludeBrainProposal, getBrainProposal } from "@/lib/brain/proposals";
import { inboxReviewReceipts as receipts } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";
import { truncateUtf16 } from "@/lib/utf8";

const log = pino({
  name: "inbox-proposal-review",
  level: process.env.LOG_LEVEL ?? "info",
});
const previewNamespace = "maister.inbox.review-preview.v1";
const previewPageChars = 262_144;
const previewCursorSchema = z.strictObject({
  scope: z.string().length(64),
  index: z
    .int()
    .min(0)
    .max(MAX_VAULT_NOTE_COUNT - 1),
  offset: z.int().min(0),
});

type Result = Readonly<{
  status: "applied" | "rejected" | "conflict" | "unavailable" | "refused";
  replayed: boolean;
  receiptId: string | null;
}>;

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

function previewScope(
  selection: ReviewSelector,
  userId: string,
  revision: string | number,
  snapshot: string,
): string {
  return createHash("sha256")
    .update(
      canonicalCommandJson([
        userId,
        selection.kind,
        selection.id,
        revision,
        snapshot,
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
  userId: string,
  rawCursor?: string,
) {
  const { proposal, bases } = await lockVaultReview(tx, selection.id, userId);

  if (proposal.state !== "pending") throw unavailableMemory();
  const scope = previewScope(
    selection,
    userId,
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
    rawCursor,
  );

  return {
    ...page,
    sourceRevisionId: bases.at(0)?.id ?? null,
  };
}

export async function getProposalReviewDetail(
  db: Db,
  userId: string,
  selection: ReviewSelector,
  cursor?: string,
) {
  return db.transaction(async (tx) => {
    const {
      projectId,
      createdAt: _createdAt,
      ...item
    } = await readProposalReviewMetadata(tx, userId, selection);
    const principal = { kind: "user", userId } as const;

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
      );

      if (proposal.status !== "pending") throw unavailableMemory();

      return {
        ...item,
        summary: proposal.content.assertion,
        sourceRevisionId: null,
        nextCursor: null,
      };
    }
    let page: Awaited<ReturnType<typeof vaultPreview>>;

    if (selection.kind === "vault") {
      page = await vaultPreview(tx, selection, userId, cursor);
    } else {
      if (!projectId) throw unavailableMemory();
      const proposal = await getBrainProposal(tx, projectId, selection.id, {
        type: "user",
        id: userId,
      });

      if (proposal.status !== "pending") throw unavailableMemory();
      const witnessId = proposal.draft.witnessId;
      const promoted =
        typeof witnessId === "string" &&
        (
          await tx.execute(
            sql`SELECT 1 FROM agent_memory_promotions WHERE proposal_id=${proposal.id}`,
          )
        ).rows.length > 0;
      const content = promoted
        ? await getKnowledgeWitnessContent(sharedTx(tx), principal, witnessId)
        : JSON.stringify(proposal.draft, null, 2);
      const digest = createHash("sha256").update(content).digest("hex");
      const scope = previewScope(selection, userId, item.version, digest);

      page = {
        ...(await pageReviewText(scope, 1, () => content, cursor)),
        sourceRevisionId: null,
      };
    }

    log.debug(
      {
        kind: selection.kind,
        proposalId: selection.id,
        continued: cursor !== undefined,
        complete: page.nextCursor === null,
      },
      "[FIX] proposal review page loaded",
    );

    return { ...item, ...page };
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
    await tx.execute<{ id: string; slug: string }>(sql`
    SELECT p.id,p.slug FROM projects p JOIN brain_proposals b ON b.project_id=p.id
    WHERE b.id=${item.id} AND p.archived_at IS NULL FOR SHARE OF p
  `)
  ).rows;

  if (!head) throw unavailableMemory();
  const proposal = await getBrainProposal(tx, head.id, item.id, {
    type: "user",
    id: userId,
  });

  if (actor.user.role !== "admin") {
    const catalog = ["rule", "skill", "flow"].includes(proposal.kind);
    const actions =
      item.decision === "reject"
        ? (["writeBrain"] as const)
        : catalog
          ? (["writeBrain", "manageCatalog"] as const)
          : (["writeBrain", "createTask"] as const);
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

async function settle(
  tx: Db,
  userId: string,
  item: ReviewDecision,
): Promise<Result> {
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

    await authorizeKnowledge(tx, principal, proposal.owner, "knowledge:review");
  }

  if (prior) {
    if (prior.digest !== digest)
      throw new MaisterError(
        "CONFLICT",
        "Review request key already belongs to another decision",
      );

    return { status: state, receiptId: prior.id, replayed: true };
  }
  if (item.kind === "vault")
    await decideVaultProposalInTransaction(tx, {
      userId,
      proposalId: item.id,
      decision: item.decision,
      expectedVersion: approvalVersion(item.expectedVersion),
      requestKey: item.requestKey,
    });
  if (item.kind === "knowledge")
    await reviewKnowledgeProposal(sharedTx(tx), {
      principal,
      proposalId: item.id,
      expectedRevision: approvalVersion(item.expectedVersion),
      decision: item.decision,
      reason: item.reason ?? "",
      idempotencyKey: item.requestKey,
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

  return { status: state, receiptId: record.id, replayed: false };
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
