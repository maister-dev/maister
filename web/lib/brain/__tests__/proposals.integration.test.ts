import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createBrainProposal,
  transitionBrainProposal,
} from "@/lib/brain/proposals";
import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";

let ctx: BrainTestDb;
let projectId: string;

async function seedEvidenceItem(): Promise<string> {
  const itemId = randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO brain_items
      (id, project_id, kind, tier, title, content, status, confidence,
       content_hash, tags, expires_at)
    VALUES
      (${itemId}, ${projectId}, 'lesson', 'owned', 'Evidence', 'Evidence body',
       'active', 0.5, ${randomUUID()}, '[]'::jsonb,
       now() + INTERVAL '30 days')
  `);

  return itemId;
}

async function proposalCount(project: string): Promise<number> {
  const rows = await ctx.db.execute(sql`
    SELECT count(*)::int AS n FROM brain_proposals WHERE project_id = ${project}
  `);

  return Number(rows.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  projectId = await seedBrainProject(ctx.db);
});

describe("brain proposals schema and FSM (T9.1)", () => {
  it("creates pending proposals and preserves evidence ids after evidence expires", async () => {
    const evidenceItemId = await seedEvidenceItem();
    const proposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "rule",
      evidenceItemIds: [evidenceItemId],
      draft: { title: "Add a rule", body: "Prefer source-backed fixes" },
      blastRadius: "low",
      autonomyDecision: "manual",
      clusterHash: "cluster-rule-1",
      actor: { type: "agent", id: "improver" },
    });

    await ctx.db.execute(sql`
      UPDATE brain_items SET status = 'expired' WHERE id = ${evidenceItemId}
    `);

    const rows = await ctx.db.execute(sql`
      SELECT status, evidence_item_ids, draft, actor
      FROM brain_proposals
      WHERE id = ${proposal.id}
    `);

    expect(rows.rows[0]).toMatchObject({
      status: "pending",
      evidence_item_ids: [evidenceItemId],
      draft: { title: "Add a rule", body: "Prefer source-backed fixes" },
      actor: { type: "agent", id: "improver" },
    });
  });

  it("allows pending -> accepted -> applied", async () => {
    const proposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "skill",
      evidenceItemIds: [],
      draft: { title: "Skill draft" },
      blastRadius: "medium",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });

    const accepted = await transitionBrainProposal(ctx.db, {
      projectId,
      proposalId: proposal.id,
      transition: "accept",
      actor: { type: "user", id: "u1" },
      reason: "Looks useful",
    });
    const applied = await transitionBrainProposal(ctx.db, {
      projectId,
      proposalId: proposal.id,
      transition: "apply",
      actor: { type: "system", id: "projection" },
      links: { authoredDraftId: "draft-1" },
    });

    expect(accepted.status).toBe("accepted");
    expect(applied).toMatchObject({
      status: "applied",
      authoredDraftId: "draft-1",
    });
  });

  it("allows pending -> rejected and rejects invalid transitions", async () => {
    const rejectedProposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "flow",
      evidenceItemIds: [],
      draft: { title: "Flow draft" },
      blastRadius: "high",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });
    const acceptedProposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "adr",
      evidenceItemIds: [],
      draft: { title: "ADR draft" },
      blastRadius: "low",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });

    const rejected = await transitionBrainProposal(ctx.db, {
      projectId,
      proposalId: rejectedProposal.id,
      transition: "reject",
      actor: { type: "user", id: "u1" },
      reason: "Not now",
    });

    await transitionBrainProposal(ctx.db, {
      projectId,
      proposalId: acceptedProposal.id,
      transition: "accept",
      actor: { type: "user", id: "u1" },
    });

    expect(rejected.status).toBe("rejected");
    await expect(
      transitionBrainProposal(ctx.db, {
        projectId,
        proposalId: acceptedProposal.id,
        transition: "reject",
        actor: { type: "user", id: "u1" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      transitionBrainProposal(ctx.db, {
        projectId,
        proposalId: rejectedProposal.id,
        transition: "apply",
        actor: { type: "system", id: "projection" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cascades proposals on project delete", async () => {
    await createBrainProposal(ctx.db, {
      projectId,
      kind: "roadmap",
      evidenceItemIds: [],
      draft: { title: "Roadmap draft" },
      blastRadius: "low",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });

    expect(await proposalCount(projectId)).toBe(1);

    await ctx.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);

    expect(await proposalCount(projectId)).toBe(0);
  });
});
