import "server-only";

import type {
  CreateKnowledgeProposalInput,
  KnowledgePrincipal,
} from "@/lib/brain/knowledge-types";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { Db } from "@/lib/execution-host/db";
import type { KnowledgeCardProposal } from "./knowledge-card-types";
import type { LibrarianOperationResult } from "./operations";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  effectContextSchema,
  isKnowledgeCardProposal,
  knowledgeCardProposalSchemas,
} from "./knowledge-card-types";
import {
  admitLibrarianOperation,
  settleLibrarianOperation,
} from "./operations";
import { resolveLibrarianVault } from "./vaults";

import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import {
  applyVaultMutationInTransaction,
  previewVaultMutation,
} from "@/lib/agent-memory-vault/store";
import { projectRolesForActions } from "@/lib/authz";
import {
  authorizeKnowledge,
  resolveKnowledgePrincipal,
} from "@/lib/brain/knowledge-access";
import { assertBrainSchemaApplied } from "@/lib/brain/guard";
import { canonicalKnowledgeRestrictions } from "@/lib/brain/knowledge-disclosure";
import { createKnowledgeProposalInTransaction } from "@/lib/brain/knowledge-proposals";
import { inspectKnowledgeEvidenceReference } from "@/lib/brain/knowledge-reference";
import {
  authorizeKnowledgeRevisionRead,
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
} from "@/lib/brain/knowledge-restrictions";
import { createBrainProposal } from "@/lib/brain/proposals";
import {
  librarianCards,
  librarianConversations,
  librarianTurns,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

type Prepared =
  | {
      kind: "knowledge_proposal";
      target: Record<string, string>;
      revision: string;
      input: Omit<CreateKnowledgeProposalInput, "idempotencyKey">;
      preview: string;
      restrictions: KnowledgeAccessRestriction[];
    }
  | {
      kind: "brain_proposal";
      target: Record<string, string>;
      revision: string;
      projectId: string;
      preview: string;
      restrictions: KnowledgeAccessRestriction[];
    }
  | {
      kind: "vault_edit";
      target: Record<string, string>;
      revision: string;
      access: Awaited<ReturnType<typeof resolveLibrarianVault>>["access"];
      projectIds: readonly string[];
      preview: string;
      restrictions: KnowledgeAccessRestriction[];
    };

const log = pino({
  name: "librarian.knowledge-effects",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function prepareKnowledgeCard(
  tx: Db,
  userId: string,
  proposal: KnowledgeCardProposal,
  inherited: readonly KnowledgeAccessRestriction[] = [],
): Promise<Prepared> {
  const principal = { kind: "user", userId } as const;
  await authorizeSourceRestrictions(tx, principal, inherited);

  if (proposal.action === "vault_edit") {
    const { access, target: owner } = await resolveLibrarianVault(
      tx,
      userId,
      proposal.vaultId,
      "edit",
    );
    const command = proposal.command;
    const { preview, dependencies, sources } = await previewVaultMutation(
      tx,
      access,
      command,
    );
    const baseSources = sources.restrictions.filter(
      (value): value is KnowledgeAccessRestriction =>
        value.kind !== "legacy_project_private",
    );
    const target: Record<string, string> = owner.project_id
      ? { projectId: owner.project_id, vaultId: owner.id }
      : { companyId: owner.company_id!, vaultId: owner.id };
    const restrictions = canonicalKnowledgeRestrictions([
      ...inherited,
      ...dependencies,
      ...baseSources,
      ...sources.projectIds.map((projectId) => ({
        kind: "project_visibility" as const,
        projectId,
      })),
    ]);

    return {
      kind: proposal.action,
      target,
      revision: contentDigest(preview),
      access,
      projectIds: sources.projectIds,
      preview: JSON.stringify(preview).slice(0, 16384),
      restrictions,
    };
  }
  await assertBrainSchemaApplied(tx);
  if (proposal.action === "brain_proposal") {
    const user = await resolveKnowledgePrincipal(
      tx,
      principal,
      "knowledge:read",
    );
    if (user.kind !== "user") throw changed();
    const roles = sql.join(
      projectRolesForActions(["writeBrain"]).map((role) => sql`${role}`),
      sql`, `,
    );
    const [project] = (
      await tx.execute<{ id: string; name: string }>(sql`
      SELECT p.id,p.name FROM projects p WHERE p.slug=${proposal.projectSlug} AND p.archived_at IS NULL AND p.brain_enabled
        AND (${user.user.role === "admin"} OR EXISTS (SELECT 1 FROM project_members m
          WHERE m.user_id=${userId} AND m.project_id=p.id AND m.role IN (${roles}) FOR SHARE)) FOR SHARE
    `)
    ).rows;
    if (!project) throw changed();
    const evidence = await tx.execute<{ id: string }>(sql`
      SELECT id FROM brain_items WHERE project_id=${project.id}
        AND id=ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(proposal.evidenceItemIds)}::jsonb)))
        AND status='active' AND visibility='owner_grants' AND coalesce(source_restrictions,'[]'::jsonb)='[]'::jsonb
        AND (expires_at IS NULL OR expires_at>transaction_timestamp()) FOR SHARE
    `);
    if (evidence.rows.length !== new Set(proposal.evidenceItemIds).size)
      throw changed();

    return {
      kind: proposal.action,
      projectId: project.id,
      target: { projectId: project.id },
      revision: contentDigest([
        project.id,
        evidence.rows.map(({ id }) => id).sort(),
      ]),
      preview: JSON.stringify(proposal.draft).slice(0, 16384),
      restrictions: canonicalKnowledgeRestrictions(inherited),
    };
  }

  const content = proposal.content;
  let input: Omit<CreateKnowledgeProposalInput, "idempotencyKey">;
  let restrictions = [...inherited];
  if (content.change === "add") {
    const { change: _change, owner, ...draft } = content;
    input = { kind: "knowledge_add", owner, principal, draft };
  } else {
    const { change: _change, recordId, expectedRevision, ...draft } = content;
    const access = await authorizeKnowledgeRevisionRead(
      tx,
      principal,
      recordId,
      expectedRevision,
    );
    const [record] = (
      await tx.execute<{
        project_id: string | null;
        company_id: string | null;
        current_revision: number;
      }>(sql`
      SELECT project_id,company_id,current_revision FROM brain_items WHERE id=${recordId} FOR SHARE
    `)
    ).rows;
    if (!record || record.current_revision !== expectedRevision)
      throw changed();
    const owner = record.project_id
      ? { kind: "project" as const, projectId: record.project_id }
      : { kind: "company" as const, companyId: record.company_id! };
    input = {
      kind: "knowledge_correct",
      owner,
      principal,
      draft,
      targetRecordId: recordId,
      expectedRecordRevision: expectedRevision,
    };
    restrictions.push(...restrictionsForKnowledgeAccess(access));
  }
  await authorizeKnowledge(tx, principal, input.owner, "knowledge:propose");
  let walk = { visited: [] as readonly string[], remaining: 256 };
  for (const evidence of input.draft.evidence)
    walk = await inspectKnowledgeEvidenceReference(
      tx,
      principal,
      evidence.reference,
      walk,
    );
  restrictions = canonicalKnowledgeRestrictions([
    ...restrictions,
    ...restrictionsForKnowledgeAccess(walk),
  ]);
  const target: Record<string, string> =
    input.owner.kind === "project"
      ? { projectId: input.owner.projectId }
      : { companyId: input.owner.companyId };

  return {
    kind: proposal.action,
    input,
    target,
    revision: contentDigest([
      target,
      input.targetRecordId,
      input.expectedRecordRevision,
    ]),
    preview: JSON.stringify(input.draft).slice(0, 16384),
    restrictions,
  };
}

function changed() {
  return new MaisterError(
    "PRECONDITION",
    "The confirmation target or source is unavailable",
    {
      details: { reason: "target_changed" },
    },
  );
}

export async function decideKnowledgeCard(
  db: Db,
  input: { cardId: string; userId: string; decision: "accept" | "reject" },
): Promise<LibrarianOperationResult> {
  return db.transaction(async (tx) => {
    const [locator] = await tx
      .select({ conversationId: librarianCards.conversationId })
      .from(librarianCards)
      .where(eq(librarianCards.id, input.cardId));
    if (!locator) throw changed();
    const [conversation] = await tx
      .select()
      .from(librarianConversations)
      .where(eq(librarianConversations.id, locator.conversationId))
      .for("update");
    const [card] = await tx
      .select()
      .from(librarianCards)
      .where(eq(librarianCards.id, input.cardId))
      .for("update");
    const context = effectContextSchema.safeParse(card?.effectContext);
    if (
      !card ||
      !context.success ||
      conversation?.userId !== input.userId ||
      conversation.resetState !== "none" ||
      conversation.currentSegmentId !== card.segmentId ||
      conversation.contextEpoch !== context.data.contextEpoch
    )
      throw changed();
    const [turn] = await tx
      .select({ id: librarianTurns.id, status: librarianTurns.status })
      .from(librarianTurns)
      .where(eq(librarianTurns.id, context.data.turnId))
      .for("share");
    if (!turn || !["running", "completed"].includes(turn.status))
      throw changed();
    const principal: KnowledgePrincipal = {
      kind: "user",
      userId: input.userId,
    };
    await resolveKnowledgePrincipal(tx, principal, "knowledge:read");
    await authorizeSourceRestrictions(tx, principal, context.data.restrictions);
    if (card.target.projectId)
      await authorizeSourceRestrictions(tx, principal, [
        { kind: "project_visibility", projectId: card.target.projectId },
      ]);
    if (card.kind === "knowledge_proposal" && card.target.companyId)
      await authorizeKnowledge(
        tx,
        principal,
        { kind: "company", companyId: card.target.companyId },
        "knowledge:read",
      );
    const key = `card:${card.id}`;
    if (card.status === "accepted" && input.decision === "accept") {
      const [effect] = (
        await tx.execute<{ result: LibrarianOperationResult }>(sql`
        SELECT result FROM librarian_operations WHERE conversation_id=${card.conversationId} AND idempotency_key=${key}
          AND status='succeeded' FOR SHARE
      `)
      ).rows;
      if (!effect) throw changed();
      if (card.target.vaultId)
        await resolveLibrarianVault(
          tx,
          input.userId,
          card.target.vaultId,
          "read",
        );

      return effect.result;
    }
    if (card.status === "rejected" && input.decision === "reject")
      return { statusCode: 200, body: { cardId: card.id, status: "rejected" } };
    if (card.status !== "pending" || card.expiresAt <= new Date())
      throw changed();
    const proposal = knowledgeCardProposalSchemas
      .map((schema) => schema.safeParse(card.payload))
      .find((entry) => entry.success)?.data;
    if (
      !proposal ||
      !isKnowledgeCardProposal(proposal) ||
      card.payloadDigest !== contentDigest(proposal)
    )
      throw changed();
    const prepared = await prepareKnowledgeCard(
      tx,
      input.userId,
      proposal,
      context.data.restrictions,
    );
    if (
      card.targetRevision !== prepared.revision ||
      contentDigest(card.target) !== contentDigest(prepared.target)
    )
      throw new MaisterError("CONFLICT", "The confirmation target changed");
    if (input.decision === "reject") {
      await tx
        .update(librarianCards)
        .set({ status: "rejected", decidedAt: new Date() })
        .where(eq(librarianCards.id, card.id));

      return { statusCode: 200, body: { cardId: card.id, status: "rejected" } };
    }

    const lockedDb = tx as unknown as Db;
    const operation = await admitLibrarianOperation(
      {
        conversationId: card.conversationId,
        segmentId: card.segmentId,
        turnId: turn.id,
        idempotencyKey: key,
        kind: "card_decide",
        target: card.target,
        body: {
          decision: "accept",
          cardId: card.id,
          digest: card.payloadDigest,
        },
        allowDuplicate: true,
      },
      lockedDb,
    );
    if (operation.reused) throw changed();
    let effect: Record<string, unknown>;
    let effectRestrictions = context.data.restrictions;
    if (prepared.kind === "vault_edit" && proposal.action === "vault_edit") {
      const result = await applyVaultMutationInTransaction(
        tx,
        { ...proposal.command, requestKey: key },
        async () => ({
          ...prepared.access,
          principalKey: `librarian:${input.userId}`,
          actor: {
            kind: "librarian",
            userId: input.userId,
            turnId: turn.id,
            cardId: card.id,
            operationId: operation.id,
          },
          sourceProjectIds: prepared.projectIds,
          sourceRestrictions: prepared.restrictions,
          resolveLinkSources: undefined,
        }),
        agentMemoryVaultLimits(),
      );
      if (result.status !== "applied")
        throw new MaisterError("CONFLICT", "Memory changed after confirmation");
      effect = {
        kind: "vault",
        operationId: result.operationId,
        revisionIds: result.affected.map(({ revisionId }) => revisionId),
      };
      effectRestrictions = canonicalKnowledgeRestrictions([
        ...effectRestrictions,
        ...result.affected.flatMap((revision) =>
          revision.hash
            ? [
                {
                  kind: "agent_vault_revision_v1" as const,
                  vaultId: prepared.access.vaultId,
                  noteId: revision.noteId,
                  revisionId: revision.revisionId,
                  contentSha256: revision.hash,
                },
              ]
            : [],
        ),
      ]);
    } else if (
      prepared.kind === "brain_proposal" &&
      proposal.action === "brain_proposal"
    ) {
      const result = await createBrainProposal(tx, {
        projectId: prepared.projectId,
        kind: proposal.kind,
        evidenceItemIds: proposal.evidenceItemIds,
        draft: proposal.draft,
        blastRadius: proposal.blastRadius,
        autonomyDecision: "manual",
        actor: { type: "user", id: input.userId },
        sourceRestrictions: prepared.restrictions,
      });
      effect = { kind: "brain", proposalId: result.id };
    } else if (prepared.kind === "knowledge_proposal") {
      const result = await createKnowledgeProposalInTransaction(tx, {
        ...prepared.input,
        idempotencyKey: key,
        inheritedRestrictions: prepared.restrictions,
      });
      effect = { kind: "knowledge", proposalId: result.id };
    } else throw changed();
    const receipt = {
      statusCode: 200,
      body: {
        status: "accepted",
        cardId: card.id,
        operationId: operation.id,
        effect,
      },
    };
    await tx
      .update(librarianCards)
      .set({
        status: "accepted",
        decidedAt: new Date(),
        effectContext: effectContextSchema.parse({
          ...context.data,
          restrictions: effectRestrictions,
        }),
      })
      .where(eq(librarianCards.id, card.id));
    await settleLibrarianOperation(
      { id: operation.id, result: receipt },
      lockedDb,
    );
    log.info(
      {
        cardId: card.id,
        operationId: operation.id,
        userId: input.userId,
        turnId: turn.id,
        kind: prepared.kind,
      },
      "librarian confirmation effect retained",
    );

    return receipt;
  });
}
