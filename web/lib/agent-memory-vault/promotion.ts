import "server-only";

import type { KnowledgePrincipal } from "@/lib/brain/knowledge-types";
import type { KnowledgeAttribution } from "@/lib/brain/record-types";
import type { Owner, VaultRevisionRestriction } from "@/lib/company/types";
import type { Db } from "@/lib/execution-host/db";
import type {
  PrepareVaultAccess,
  Vault,
  VaultAccess,
  VaultRevision,
} from "./store";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { memoryNotePath } from "./paths";
import {
  loadActiveHeads,
  lockVault,
  readVaultPayload,
  readVaultRevision,
  unavailableMemory,
} from "./store";

import {
  assertBrainSchemaApplied,
  assertProjectBrainEnabled,
} from "@/lib/brain/guard";
import { authorizeKnowledge } from "@/lib/brain/knowledge-access";
import { lockKnowledgeWriteConsumer } from "@/lib/brain/knowledge-disclosure";
import { createKnowledgeProposalInTransaction } from "@/lib/brain/knowledge-proposals";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { createBrainProposal } from "@/lib/brain/proposals";
import {
  agentMemoryOperations as operations,
  agentMemoryPromotions as promotions,
} from "@/lib/db/schema";
import {
  installationProjectAccess,
  requireInstallationCredential,
} from "@/lib/agents/installation-authority";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-memory-promotion",
  level: process.env.LOG_LEVEL ?? "info",
});
const targetId = z
  .string()
  .min(1)
  .max(192)
  .refine((value) => !value.includes("\0") && value.isWellFormed());
const promotionInput = z.strictObject({
  path: z.string().min(1).max(512),
  ifRevisionId: targetId,
  ifHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/),
  target: z.strictObject({
    kind: z.enum(["brain", "knowledge"]),
    ownerKind: z.enum(["project", "company"]),
    ownerId: targetId,
  }),
});

export function parseMemoryPromotion(input: unknown) {
  const parsed = promotionInput.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid memory promotion request");

  return { ...parsed.data, path: memoryNotePath(parsed.data.path) };
}

async function ensureWitness(
  tx: Db,
  sourceOwner: Owner,
  source: VaultRevisionRestriction,
  author: KnowledgeAttribution,
) {
  const sourceId = `agent-vault:${source.revisionId}`;
  const owner =
    sourceOwner.kind === "project"
      ? { projectId: sourceOwner.projectId, companyId: null }
      : { projectId: null, companyId: sourceOwner.companyId };
  const previous = await tx.execute<{ id: string }>(sql`
    SELECT w.id FROM brain_evidence_witnesses w JOIN brain_evidence_observations o ON w.observation_id=o.id
    WHERE o.source_id=${sourceId} AND o.content_sha256=${source.contentSha256} AND w.selector='vault:revision'
      AND o.project_id IS NOT DISTINCT FROM ${owner.projectId} AND o.company_id IS NOT DISTINCT FROM ${owner.companyId}
  `);

  if (previous.rows[0]) return previous.rows[0].id;
  const locator = { kind: "vault_revision", revisionId: source.revisionId };
  const result = await tx.execute<{ id: string }>(sql`
    WITH observation AS (
      INSERT INTO brain_evidence_observations(project_id,company_id,source_id,source_version,content_sha256,attribution)
      VALUES(${owner.projectId},${owner.companyId},${sourceId},${source.revisionId},${source.contentSha256},${JSON.stringify(author)}::jsonb)
      RETURNING id
    )
    INSERT INTO brain_evidence_witnesses(observation_id,source_version,content_sha256,selector,restrictions,capture_locator)
    SELECT id,${source.revisionId},${source.contentSha256},'vault:revision',${JSON.stringify([source])}::jsonb,${JSON.stringify(locator)}::jsonb
    FROM observation RETURNING id
  `);

  if (!result.rows[0])
    throw new MaisterError("CRASH", "Vault evidence witness was not retained");

  return result.rows[0].id;
}

function sourceOwner(vault: Vault): Owner {
  if (vault.projectId) return { kind: "project", projectId: vault.projectId };
  if (vault.companyId) return { kind: "company", companyId: vault.companyId };
  throw new MaisterError("CRASH", "Vault owner is unavailable");
}

function attribution(access: VaultAccess): KnowledgeAttribution {
  const author = access.actor;

  if (author.kind === "agent_session")
    return {
      kind: "agent",
      id: author.agentId,
      runId: author.runId,
      attemptId: author.nodeAttemptId,
    };

  return { kind: "user", id: author.userId, runId: null, attemptId: null };
}

async function authorizePromotionNote(
  tx: Db,
  access: VaultAccess,
  principal: KnowledgePrincipal,
  revision: VaultRevision,
) {
  if (!revision.contentSha256 || !(await access.canRead(tx, revision)))
    throw unavailableMemory();
  const source: VaultRevisionRestriction = {
    kind: "agent_vault_revision_v1",
    vaultId: revision.vaultId,
    noteId: revision.noteId,
    revisionId: revision.id,
    contentSha256: revision.contentSha256,
  };

  const inspection =
    access.visibleGeneration && access.actor.kind === "agent_session"
      ? {
          kind: "execution" as const,
          runId: access.actor.runId,
          nodeAttemptId: null,
        }
      : principal;

  await authorizeSourceRestrictions(tx, inspection, [source]);

  return source;
}

export async function promoteMemory(
  db: Db,
  principal: KnowledgePrincipal,
  input: ReturnType<typeof parseMemoryPromotion>,
  prepare: PrepareVaultAccess,
) {
  const result = await db.transaction(async (tx) => {
    await assertBrainSchemaApplied(tx);
    await lockKnowledgeWriteConsumer(tx, principal);
    const access = await prepare(tx);
    const target: Owner =
      input.target.ownerKind === "project"
        ? { kind: "project", projectId: input.target.ownerId }
        : { kind: "company", companyId: input.target.ownerId };

    if (input.target.kind === "knowledge")
      await authorizeKnowledge(tx, principal, target, "knowledge:propose");
    const vault = await lockVault(tx, access.vaultId);
    const author = attribution(access);

    if (input.target.kind === "brain") {
      if (target.kind !== "project") throw unavailableMemory();
      await assertProjectBrainEnabled(tx, target.projectId);
      if (vault.companyId && principal.kind === "token") {
        const context = await requireInstallationCredential(
          tx,
          principal.tokenId,
          "memory:propose",
        );

        if (!context.scopes.includes("agent_memory:read"))
          throw unavailableMemory();
        const decision =
          await tx.execute(sql`SELECT id FROM projects p WHERE p.id=${target.projectId}
          AND p.archived_at IS NULL AND ${installationProjectAccess(context, sql`p.id`, "writeBrain")} FOR SHARE`);

        if (!decision.rows.length) throw unavailableMemory();
      } else if (vault.companyId) {
        await authorizeKnowledge(tx, principal, target, "knowledge:propose");
      } else if (target.projectId !== vault.projectId)
        throw unavailableMemory();
      else if (author.kind === "agent") {
        const grant =
          await tx.execute(sql`SELECT 1 FROM agent_project_links WHERE project_id=${target.projectId}
          AND agent_id=${author.id} AND enabled AND can_write_brain FOR SHARE`);

        if (!grant.rows.length)
          throw new MaisterError(
            "UNAUTHORIZED",
            "The agent cannot propose to the target Brain",
          );
      }
    }
    const digest = createHash("sha256")
      .update(canonicalCommandJson(input))
      .digest("hex");
    const [prior] = await tx
      .select({ operation: operations, promotion: promotions })
      .from(operations)
      .leftJoin(promotions, eq(promotions.operationId, operations.id))
      .where(
        and(
          eq(operations.vaultId, vault.id),
          eq(operations.principalKey, access.principalKey),
          eq(operations.requestKey, input.requestKey),
        ),
      );

    if (prior) {
      if (prior.operation.commandDigest !== digest || !prior.promotion)
        throw new MaisterError(
          "CONFLICT",
          "Memory request key already belongs to another operation",
        );
      const original = await readVaultRevision(
        tx,
        vault.id,
        prior.promotion.noteId,
        prior.promotion.revisionId,
      );

      await authorizePromotionNote(tx, access, principal, original);
      await access.capture(tx, [original]);

      return {
        status: "pending" as const,
        operationId: prior.operation.id,
        proposalId: prior.promotion.proposalId,
      };
    }
    const current = (await loadActiveHeads(tx, vault.id)).find(
      ({ revision }) => revision.path === input.path,
    )?.revision;

    if (!current) throw unavailableMemory();
    const source = await authorizePromotionNote(tx, access, principal, current);

    if (
      source.revisionId !== input.ifRevisionId ||
      source.contentSha256 !== input.ifHash
    )
      throw new MaisterError(
        "CONFLICT",
        "Vault revision changed while preparing the promotion",
      );
    const witnessId = await ensureWitness(
      tx,
      sourceOwner(vault),
      source,
      author,
    );
    const operationId = randomUUID();
    let proposalId: string;

    if (input.target.kind === "brain" && target.kind === "project") {
      proposalId = (
        await createBrainProposal(tx, {
          projectId: target.projectId,
          kind: "state",
          evidenceItemIds: [],
          draft: { title: "Agent memory proposal", witnessId },
          autonomyDecision: "manual",
          blastRadius: "low",
          actor: {
            type: author.kind === "agent" ? "agent" : "user",
            id: author.id!,
          },
          sourceRestrictions: [source],
        })
      ).id;
    } else {
      const assertion = await readVaultPayload(tx, current);

      proposalId = (
        await createKnowledgeProposalInTransaction(tx, {
          kind: "knowledge_add",
          owner: target,
          principal,
          idempotencyKey: `vault:${operationId}`,
          draft: {
            title: "Agent memory proposal",
            kind: "assertion",
            assertion,
            basis: "inferred",
            evidence: [
              {
                relation: "derived_from",
                reference: { kind: "witness", id: witnessId },
              },
            ],
            limitations: [],
            missingEvidence: [],
          },
        })
      ).id;
    }
    await tx.insert(operations).values({
      id: operationId,
      vaultId: vault.id,
      principalKey: access.principalKey,
      requestKey: input.requestKey,
      commandKind: "promote",
      commandDigest: digest,
      outcome: "pending",
    });
    await tx.insert(promotions).values({
      operationId,
      vaultId: vault.id,
      noteId: source.noteId,
      revisionId: source.revisionId,
      proposalId,
    });
    await access.capture(tx, [current]);

    return { status: "pending" as const, operationId, proposalId };
  });

  log.info(
    {
      operationId: result.operationId,
      proposalId: result.proposalId,
      targetKind: input.target.kind,
    },
    "vault promotion submitted",
  );

  return result;
}
