import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  concludeBrainProposal,
  createBrainProposal,
  createBrainProposalWithAutonomy,
  transitionBrainProposal,
} from "@/lib/brain/proposals";
import { promoteNextPending } from "@/lib/scheduler";
import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";

let ctx: BrainTestDb;
let projectId: string;
let projectSlug: string;

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

async function proposalDecisionStats(
  kind: string,
  blastRadius: string,
): Promise<{
  acceptedCount: number;
  rejectedCount: number;
  autoDraftedCount: number;
}> {
  const rows = await ctx.db.execute(sql`
    SELECT accepted_count, rejected_count, auto_drafted_count
    FROM brain_proposal_decision_stats
    WHERE project_id = ${projectId}
      AND kind = ${kind}
      AND blast_radius = ${blastRadius}
    LIMIT 1
  `);
  const row = rows.rows[0];

  return {
    acceptedCount: Number(row?.accepted_count ?? 0),
    rejectedCount: Number(row?.rejected_count ?? 0),
    autoDraftedCount: Number(row?.auto_drafted_count ?? 0),
  };
}

async function seedProjectionFlow(): Promise<string> {
  const flowId = `projection-flow-${randomUUID().slice(0, 8)}`;

  await ctx.db.execute(sql`
    INSERT INTO flows (
      id,
      project_id,
      flow_ref_id,
      source,
      version,
      revision,
      installed_path,
      manifest,
      schema_version,
      enablement_state,
      trust_status
    )
    VALUES (
      ${flowId},
      ${projectId},
      ${flowId},
      'test',
      '1.0.0',
      'test',
      '/tmp/projection-flow',
      '{"nodes":[]}'::jsonb,
      1,
      'Enabled',
      'trusted'
    )
  `);

  return flowId;
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  projectSlug = `brain-proposals-${randomUUID().slice(0, 8)}`;
  projectId = await seedBrainProject(ctx.db, { slug: projectSlug });
  await ctx.db.execute(sql`
    INSERT INTO users (id, email, name, role, account_status)
    VALUES (
      'reviewer-1',
      'reviewer-1@example.test',
      'Reviewer',
      'member',
      'active'
    )
    ON CONFLICT (id) DO NOTHING
  `);
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
    await expect(
      proposalDecisionStats("skill", "medium"),
    ).resolves.toMatchObject({
      acceptedCount: 1,
      rejectedCount: 0,
      autoDraftedCount: 0,
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
    await expect(proposalDecisionStats("flow", "high")).resolves.toMatchObject({
      acceptedCount: 0,
      rejectedCount: 1,
      autoDraftedCount: 0,
    });
    await expect(proposalDecisionStats("adr", "low")).resolves.toMatchObject({
      acceptedCount: 1,
      rejectedCount: 0,
      autoDraftedCount: 0,
    });
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

describe("brain proposal conclusion and authored draft bridge (T11.1)", () => {
  it("accepts rule/skill/flow proposals into unpublished M25 authored drafts", async () => {
    const proposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "skill",
      evidenceItemIds: [],
      draft: {
        slug: "review-checklist",
        title: "Review Checklist",
        body: { markdown: "Check contracts, migrations, and analytics." },
        schemaVersion: 1,
      },
      blastRadius: "low",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });

    const applied = await concludeBrainProposal(ctx.db, {
      projectId,
      projectSlug,
      proposalId: proposal.id,
      action: "accept",
      actor: { type: "user", id: "reviewer-1" },
      reason: "Good draft",
    });

    expect(applied).toMatchObject({
      status: "applied",
      kind: "skill",
      authoredDraftId: expect.any(String),
      resolution: {
        actor: { type: "user", id: "reviewer-1" },
        reason: "Good draft",
      },
    });

    const authoredRows = await ctx.db.execute(sql`
      SELECT
        cap.kind,
        cap.slug,
        cap.title,
        cap.lifecycle,
        cap.current_published_revision_id,
        rev.lifecycle AS revision_lifecycle,
        rev.body,
        rev.schema_version
      FROM authored_capabilities cap
      INNER JOIN authored_capability_revisions rev
        ON rev.id = cap.current_draft_revision_id
      WHERE cap.id = ${applied.authoredDraftId}
        AND cap.project_id = ${projectId}
      LIMIT 1
    `);

    expect(authoredRows.rows[0]).toMatchObject({
      kind: "skill",
      slug: "review-checklist",
      title: "Review Checklist",
      lifecycle: "DRAFT",
      current_published_revision_id: null,
      revision_lifecycle: "DRAFT",
      body: { markdown: "Check contracts, migrations, and analytics." },
      schema_version: 1,
    });

    const publishedRows = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM capability_records
      WHERE project_id = ${projectId}
        AND material->>'authoredCapabilityId' = ${applied.authoredDraftId}
    `);

    expect(Number(publishedRows.rows[0]?.n ?? 0)).toBe(0);
  });

  it("rejects proposals with a human reason", async () => {
    const proposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "roadmap",
      evidenceItemIds: [],
      draft: { title: "Roadmap draft" },
      blastRadius: "medium",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });

    const rejected = await concludeBrainProposal(ctx.db, {
      projectId,
      projectSlug,
      proposalId: proposal.id,
      action: "reject",
      actor: { type: "user", id: "reviewer-1" },
      reason: "Not aligned",
    });

    expect(rejected).toMatchObject({
      status: "rejected",
      resolution: {
        actor: { type: "user", id: "reviewer-1" },
        reason: "Not aligned",
      },
    });
  });

  it("refuses machine actors and stale proposal conclusions", async () => {
    const proposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "rule",
      evidenceItemIds: [],
      draft: {
        slug: "small-rule",
        title: "Small Rule",
        body: { markdown: "Prefer small patches." },
      },
      blastRadius: "low",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });

    await expect(
      concludeBrainProposal(ctx.db, {
        projectId,
        projectSlug,
        proposalId: proposal.id,
        action: "reject",
        actor: { type: "agent", id: "improver" },
        reason: "Machine cannot decide",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await concludeBrainProposal(ctx.db, {
      projectId,
      projectSlug,
      proposalId: proposal.id,
      action: "reject",
      actor: { type: "user", id: "reviewer-1" },
      reason: "Close it",
    });

    await expect(
      concludeBrainProposal(ctx.db, {
        projectId,
        projectSlug,
        proposalId: proposal.id,
        action: "accept",
        actor: { type: "user", id: "reviewer-1" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("brain proposal autonomy (T12.1)", () => {
  it("auto-drafts an allowed low-radius catalog proposal without publishing it", async () => {
    await ctx.db.execute(sql`
      INSERT INTO brain_project_config (project_id, home_resolution, autonomy_policy)
      VALUES (${projectId}, '{}'::jsonb, '{"rule.low":"auto_draft"}'::jsonb)
      ON CONFLICT (project_id)
      DO UPDATE SET autonomy_policy = EXCLUDED.autonomy_policy
    `);

    const proposal = await createBrainProposalWithAutonomy(ctx.db, {
      projectId,
      projectSlug,
      kind: "rule",
      evidenceItemIds: [],
      draft: {
        slug: "small-patch-rule",
        title: "Small Patch Rule",
        body: { markdown: "Prefer small, reviewed patches." },
      },
      blastRadius: "low",
      clusterHash: "auto-rule-low",
      actor: { type: "agent", id: "improver" },
    });

    expect(proposal).toMatchObject({
      status: "applied",
      autonomyDecision: "auto_draft",
      authoredDraftId: expect.any(String),
      resolution: {
        actor: { type: "system", id: "brain-autonomy" },
        reason: "auto_draft",
      },
    });

    const rows = await ctx.db.execute(sql`
      SELECT cap.lifecycle, cap.current_published_revision_id, rev.lifecycle AS revision_lifecycle
      FROM authored_capabilities cap
      INNER JOIN authored_capability_revisions rev
        ON rev.id = cap.current_draft_revision_id
      WHERE cap.id = ${proposal.authoredDraftId}
      LIMIT 1
    `);

    expect(rows.rows[0]).toMatchObject({
      lifecycle: "DRAFT",
      current_published_revision_id: null,
      revision_lifecycle: "DRAFT",
    });

    const records = await ctx.db.execute(sql`
      SELECT count(*)::int AS n
      FROM capability_records
      WHERE project_id = ${projectId}
        AND material->>'authoredCapabilityId' = ${proposal.authoredDraftId}
    `);

    expect(Number(records.rows[0]?.n ?? 0)).toBe(0);
    await expect(proposalDecisionStats("rule", "low")).resolves.toMatchObject({
      acceptedCount: 1,
      rejectedCount: 0,
      autoDraftedCount: 1,
    });
  });

  it("keeps high-radius proposals human-gated even when low-radius auto_draft exists", async () => {
    await ctx.db.execute(sql`
      INSERT INTO brain_project_config (project_id, home_resolution, autonomy_policy)
      VALUES (${projectId}, '{}'::jsonb, '{"rule.low":"auto_draft"}'::jsonb)
      ON CONFLICT (project_id)
      DO UPDATE SET autonomy_policy = EXCLUDED.autonomy_policy
    `);

    const proposal = await createBrainProposalWithAutonomy(ctx.db, {
      projectId,
      projectSlug,
      kind: "rule",
      evidenceItemIds: [],
      draft: {
        slug: "large-rule",
        title: "Large Rule",
        body: { markdown: "Large change." },
      },
      blastRadius: "high",
      actor: { type: "agent", id: "improver" },
    });

    expect(proposal).toMatchObject({
      status: "pending",
      autonomyDecision: "manual",
      authoredDraftId: null,
    });
  });
});

describe("brain docs-as-code projection tasks (T12.2)", () => {
  it("accepts state proposals into a Backlog task with drafted path/content", async () => {
    const proposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "state",
      evidenceItemIds: [],
      draft: {
        title: "Document current Brain state",
        path: "docs/brain/state.md",
        content: "Current Brain projection rules are project-scoped.",
      },
      blastRadius: "medium",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });

    const applied = await concludeBrainProposal(ctx.db, {
      projectId,
      projectSlug,
      proposalId: proposal.id,
      action: "accept",
      actor: { type: "user", id: "reviewer-1" },
      reason: "Project it out",
    });

    expect(applied).toMatchObject({
      status: "applied",
      taskId: expect.any(String),
      authoredDraftId: null,
    });

    const rows = await ctx.db.execute(sql`
      SELECT title, prompt, status, stage, flow_id, triage_status, launch_mode
      FROM tasks
      WHERE id = ${applied.taskId}
        AND project_id = ${projectId}
      LIMIT 1
    `);

    expect(rows.rows[0]).toMatchObject({
      title: "Project Brain state: Document current Brain state",
      status: "Backlog",
      stage: "Backlog",
      flow_id: null,
      triage_status: null,
      launch_mode: null,
    });
    expect(String(rows.rows[0]?.prompt)).toContain("docs/brain/state.md");
    expect(String(rows.rows[0]?.prompt)).toContain(
      "Current Brain projection rules are project-scoped.",
    );
  });

  it("stamps projection flow triage and is eligible for auto-launch", async () => {
    const flowId = await seedProjectionFlow();

    await ctx.db.execute(sql`
      INSERT INTO brain_project_config (
        project_id,
        home_resolution,
        projection_flow_id,
        autonomy_policy
      )
      VALUES (${projectId}, '{}'::jsonb, ${flowId}, '{}'::jsonb)
      ON CONFLICT (project_id)
      DO UPDATE SET projection_flow_id = EXCLUDED.projection_flow_id
    `);

    const proposal = await createBrainProposal(ctx.db, {
      projectId,
      kind: "adr",
      evidenceItemIds: [],
      draft: {
        title: "ADR for projection flow",
        path: "docs/decisions/adr-projection.md",
        content: "# ADR\n\nUse the task machine for docs projection.",
      },
      blastRadius: "high",
      autonomyDecision: "manual",
      actor: { type: "agent", id: "improver" },
    });

    const applied = await concludeBrainProposal(ctx.db, {
      projectId,
      projectSlug,
      proposalId: proposal.id,
      action: "accept",
      actor: { type: "user", id: "reviewer-1" },
    });
    const rows = await ctx.db.execute(sql`
      SELECT flow_id, triage_status, launch_mode
      FROM tasks
      WHERE id = ${applied.taskId}
      LIMIT 1
    `);

    expect(rows.rows[0]).toMatchObject({
      flow_id: flowId,
      triage_status: "triaged",
      launch_mode: "auto",
    });

    const launchedTaskIds: string[] = [];
    const promoted = await promoteNextPending({
      db: ctx.db,
      launchRun: async (taskId) => {
        launchedTaskIds.push(taskId);

        return { runId: "projection-run-1", status: "Running" };
      },
    });

    expect(launchedTaskIds).toEqual([applied.taskId]);
    expect(promoted.promotedRunId).toBe("projection-run-1");
  });
});
