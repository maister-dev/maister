import "server-only";

import type { CreateBrainProposalInput } from "@/lib/brain/proposals";
import type { BrainItemKind } from "@/lib/brain/schema";
import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

import {
  installationProjectAccess,
  requireInstallationCredential,
} from "./installation-authority";
import {
  captureInstallationProjects,
  installationRunProjects,
} from "./installation-source-capture";

import { assertBrainSchemaApplied } from "@/lib/brain/guard";
import { lockKnowledgeReadConsumer } from "@/lib/brain/knowledge-disclosure";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { getBrainEmbeddingClient } from "@/lib/brain/openai-compatible";
import { createBrainProposal } from "@/lib/brain/proposals";
import { recall, writeBrainSnapshot } from "@/lib/brain/recall";
import { RANKER_VERSION } from "@/lib/brain/recall-ranker";
import { MaisterError } from "@/lib/errors";

async function requireBrainProject(
  tx: Db,
  tokenId: string,
  slug: string,
  action: "memory:read" | "memory:propose",
) {
  const context = await requireInstallationCredential(tx, tokenId, action);
  await assertBrainSchemaApplied(tx);
  const [project] = (
    await tx.execute<{ id: string }>(sql`
    SELECT p.id FROM projects p WHERE p.slug=${slug} AND p.archived_at IS NULL AND p.brain_enabled
      AND ${installationProjectAccess(context, sql`p.id`, action === "memory:read" ? "readBrain" : "writeBrain")} FOR SHARE
  `)
  ).rows;
  if (!project)
    throw new MaisterError("PRECONDITION", "Resource unavailable", {
      details: { reason: "installation_resource_unavailable" },
    });

  return { context, projectId: project.id };
}

export async function recallInstallationBrain(
  db: Db,
  tokenId: string,
  slug: string,
  query: Readonly<{
    q: string;
    limit?: number;
    kinds: BrainItemKind[];
    minConfidence?: number;
  }>,
) {
  return db.transaction(async (tx) => {
    const { context, projectId } = await requireBrainProject(
      tx,
      tokenId,
      slug,
      "memory:read",
    );
    const client = await getBrainEmbeddingClient(tx);
    const hits = (
      await recall(projectId, query.q, {
        db: tx,
        client,
        limit: query.limit,
        kinds: query.kinds,
        minConfidence: query.minConfidence,
        sourceClass: "owned",
      })
    ).filter((hit) => hit.tier === "owned");
    await captureInstallationProjects(tx, context.runId, [projectId]);
    await writeBrainSnapshot(tx, {
      projectId,
      runId: context.runId,
      actorId: context.agentId,
      actorType: "agent",
      trigger: "explicit",
      query: query.q,
      embeddingModel: client.model,
      rankerVersion: RANKER_VERSION,
      returnedItems: hits.map(({ itemId, score }) => ({
        tier: "owned",
        itemId,
        score,
      })),
    });

    return { items: hits };
  });
}

type BrainDraft = Pick<
  CreateBrainProposalInput,
  "kind" | "draft" | "blastRadius" | "evidenceItemIds" | "clusterHash"
>;

export async function proposeInstallationBrain(
  db: Db,
  tokenId: string,
  slug: string,
  draft: BrainDraft,
) {
  return db.transaction(async (tx) => {
    const { context, projectId } = await requireBrainProject(
      tx,
      tokenId,
      slug,
      "memory:propose",
    );
    if (draft.evidenceItemIds.length > 64)
      throw new MaisterError(
        "CONFIG",
        "An installation Brain proposal can reference at most 64 evidence items",
      );
    const evidence = await tx.execute(sql`
      SELECT id FROM brain_items WHERE project_id=${projectId} AND id=ANY(ARRAY(
        SELECT jsonb_array_elements_text(${JSON.stringify(draft.evidenceItemIds)}::jsonb)))
        AND status='active' AND visibility='owner_grants' AND coalesce(source_restrictions,'[]'::jsonb)='[]'::jsonb
        AND (expires_at IS NULL OR expires_at>transaction_timestamp()) FOR SHARE
    `);
    if (evidence.rows.length !== new Set(draft.evidenceItemIds).size)
      throw new MaisterError(
        "PRECONDITION",
        "Proposal evidence is unavailable",
      );
    const principal = {
      kind: "execution" as const,
      runId: context.runId,
      nodeAttemptId: null,
    };
    const retained = await lockKnowledgeReadConsumer(tx, principal);
    const projectIds = await installationRunProjects(tx, context.runId);
    const sourceRestrictions = [
      ...(retained?.capture.restrictions ?? []),
      ...projectIds.map((id) => ({
        kind: "project_visibility" as const,
        projectId: id,
      })),
    ];
    await authorizeSourceRestrictions(tx, principal, sourceRestrictions);

    return createBrainProposal(tx, {
      ...draft,
      projectId,
      sourceRestrictions,
      autonomyDecision: "manual",
      actor: { type: "agent", id: context.agentId },
    });
  });
}
