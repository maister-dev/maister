import "server-only";

import type {
  ReviewDecision,
  ReviewSelector,
} from "./knowledge-memory-reviews";
import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { readProposalReviewMetadata } from "./knowledge-memory-reviews";

import {
  insertMemoryText,
  replaceMemoryText,
} from "@/lib/agent-memory-vault/commands";
import { vaultProposalBases } from "@/lib/agent-memory-vault/proposals";
import {
  decideVaultProposalInTransaction,
  lockProjectVaultReview,
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
import { getKnowledgeWitness } from "@/lib/brain/knowledge-witnesses";
import { concludeBrainProposal, getBrainProposal } from "@/lib/brain/proposals";
import { inboxReviewReceipts as receipts } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { truncateUtf16 } from "@/lib/utf8";

const log = pino({
  name: "inbox-proposal-review",
  level: process.env.LOG_LEVEL ?? "info",
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

async function vaultPreview(tx: Db, selection: ReviewSelector, userId: string) {
  const { proposal } = await lockProjectVaultReview(tx, selection.id, userId);
  const command = await readVaultProposalCommand(tx, proposal);
  const bases = await vaultProposalBases(
    tx,
    proposal.vaultId,
    proposal.operationId,
  );
  const patches: string[] = [];
  let chars = 0;

  for (const change of proposal.changes) {
    const base = bases.find(
      (revision) => revision.id === change.beforeRevisionId,
    );
    const before = base?.contentSha256 ? await readVaultPayload(tx, base) : "";
    let after = "";

    if (command.command === "create") after = command.file_text;
    if (command.command === "rename") after = before;
    if (command.command === "insert")
      after = insertMemoryText(
        before,
        command.insert_line,
        command.insert_text,
      );
    if (command.command === "str_replace")
      after = replaceMemoryText(before, command.old_str, command.new_str);
    if (command.command === "revert") {
      const target = bases.find(
        (revision) => revision.id === command.revisionId,
      );

      if (!target) throw unavailableMemory();
      after = await readVaultPayload(tx, target);
    }
    const patch =
      `--- ${base?.path ?? "/dev/null"}\n+++ ${change.kind === "deleted" ? "/dev/null" : change.path}\n` +
      `${
        before
          ? before
              .split("\n")
              .map((line) => `-${line}`)
              .join("\n")
          : ""
      }\n` +
      `${
        after
          ? after
              .split("\n")
              .map((line) => `+${line}`)
              .join("\n")
          : ""
      }`;

    patches.push(truncateUtf16(patch, 262144 - chars));
    chars += (patches.at(-1)?.length ?? 0) + 1;
    if (chars >= 262144) break;
  }

  return {
    summary: truncateUtf16(patches.join("\n"), 262144),
    sourceRevisionId: bases[0]?.id ?? null,
  };
}

export async function getProposalReviewDetail(
  db: Db,
  userId: string,
  selection: ReviewSelector,
) {
  return db.transaction(async (tx) => {
    const { projectId, createdAt, ...item } = await readProposalReviewMetadata(
      tx,
      userId,
      selection,
    );
    const principal = { kind: "user", userId } as const;
    if (selection.kind === "vault")
      return { ...item, ...(await vaultPreview(tx, selection, userId)) };
    if (selection.kind === "knowledge") {
      const proposal = await getKnowledgeProposal(
        sharedTx(tx),
        principal,
        selection.id,
      );

      return {
        ...item,
        summary: proposal.content.assertion,
        sourceRevisionId: null,
      };
    }
    if (!projectId) throw unavailableMemory();
    const proposal = await getBrainProposal(tx, projectId, selection.id, {
      type: "user",
      id: userId,
    });
    const witnessId =
      typeof proposal.draft.witnessId === "string"
        ? (
            await tx.execute(
              sql`SELECT 1 FROM agent_memory_promotions WHERE proposal_id=${proposal.id}`,
            )
          ).rows[0]
          ? proposal.draft.witnessId
          : null
        : null;
    const proof = witnessId
      ? await getKnowledgeWitness(sharedTx(tx), principal, witnessId)
      : null;

    return {
      ...item,
      summary:
        proof?.excerpt ??
        truncateUtf16(JSON.stringify(proposal.draft, null, 2), 262144),
      sourceRevisionId: null,
    };
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
    await lockProjectVaultReview(tx, item.id, userId);
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
