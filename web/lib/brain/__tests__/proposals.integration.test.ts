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

  it("configures projection flow without fabricating qualification or launch authority", async () => {
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

    expect(launchedTaskIds).toEqual([]);
    expect(promoted.promotedRunId).toBeNull();
    const admission = await ctx.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM task_qualifications WHERE task_id = ${applied.taskId}) AS assessments,
        (SELECT count(*)::int FROM task_launch_intents WHERE task_id = ${applied.taskId}) AS intents,
        (SELECT count(*)::int FROM runs WHERE task_id = ${applied.taskId}) AS runs
    `);

    expect(admission.rows).toEqual([{ assessments: 0, intents: 0, runs: 0 }]);
  });
});

it("IT-CBK-03 company knowledge publication is attributable, idempotent and separate from confirmation", async () => {
  const native = await import("@/lib/brain/proposals");
  const company = (
    await ctx.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!;
  const reviewerId = randomUUID();

  await ctx.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [reviewerId, `${reviewerId}@example.test`],
  );
  await ctx.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,$2 FROM unnest(ARRAY['knowledge:read','knowledge:propose','knowledge:review','knowledge:confirm']) action",
    [company.id, reviewerId],
  );
  const input = {
    owner: { kind: "company" as const, companyId: company.id },
    kind: "knowledge_add" as const,
    principal: { kind: "user" as const, userId: reviewerId },
    idempotencyKey: "proposal_example_001",
    draft: {
      title: "Restart evidence requirement",
      kind: "procedure" as const,
      assertion: "A restart requires independent verification.",
      basis: "inferred" as const,
      evidence: [],
      missingEvidence: [
        {
          state: "absent" as const,
          reason: "No execution evidence is available.",
        },
      ],
      limitations: [
        "Pending operational qualification",
        "No observed execution is claimed",
      ],
    },
  };

  await expect(
    createBrainProposal(ctx.db, {
      ...input,
      targetRecordId: randomUUID(),
      idempotencyKey: "invalid_partial_target_001",
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  await expect(
    createBrainProposal(ctx.db, {
      ...input,
      kind: "knowledge_correct",
      targetRecordId: randomUUID(),
      expectedRecordRevision: 2147483648,
      idempotencyKey: "invalid_large_revision_001",
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  const proposed = await createBrainProposal(ctx.db, input);

  expect(proposed).toMatchObject({ status: "pending", duplicate: false });
  const alias = {
    ...input,
    draft: {
      ...input.draft,
      limitations: [...input.draft.limitations].reverse(),
    },
    idempotencyKey: "proposal_example_alias_001",
  };

  expect(await createBrainProposal(ctx.db, alias)).toMatchObject({
    id: proposed.id,
    duplicate: true,
  });
  await expect(
    createBrainProposal(ctx.db, {
      ...alias,
      draft: { ...input.draft, assertion: "Changed alias input" },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await createBrainProposal(ctx.db, input)).id).toBe(proposed.id);
  await expect(
    createBrainProposal(ctx.db, {
      ...input,
      draft: {
        ...input.draft,
        assertion: "Different request with reused delivery key",
      },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const otherReviewerId = randomUUID();

  await ctx.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [otherReviewerId, `${otherReviewerId}@example.test`],
  );
  await ctx.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,$2 FROM unnest(ARRAY['knowledge:read','knowledge:propose','knowledge:review']) action",
    [company.id, otherReviewerId],
  );
  const repeatedByOther = await createBrainProposal(ctx.db, {
    ...input,
    principal: { kind: "user", userId: otherReviewerId },
    idempotencyKey: "proposal_other_reviewer_001",
  });
  const decision = {
    proposalId: proposed.id,
    principal: input.principal,
    expectedRevision: 1,
    decision: "accept" as const,
    reason: "Publish the reviewed procedure",
    idempotencyKey: "decision_example_001",
  };

  await ctx.pool.query(
    "CREATE FUNCTION reject_knowledge_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event write failure'; END $$; CREATE TRIGGER reject_knowledge_test_event BEFORE INSERT ON domain_events FOR EACH ROW WHEN (NEW.kind='knowledge.record_changed') EXECUTE FUNCTION reject_knowledge_test_event()",
  );
  try {
    await expect(
      native.reviewKnowledgeProposal(ctx.db, decision),
    ).rejects.toMatchObject({ code: "CRASH" });
    expect(
      (
        await ctx.pool.query(
          "SELECT status,published_record_id FROM brain_proposals WHERE id=$1",
          [proposed.id],
        )
      ).rows,
    ).toEqual([{ status: "pending", published_record_id: null }]);
    expect(
      (
        await ctx.pool.query(
          "SELECT id FROM brain_record_changes WHERE proposal_id=$1",
          [proposed.id],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await ctx.pool.query(
      "DROP TRIGGER reject_knowledge_test_event ON domain_events; DROP FUNCTION reject_knowledge_test_event()",
    );
  }
  const accepted = await native.reviewKnowledgeProposal(ctx.db, decision);

  expect(accepted).toMatchObject({ status: "accepted", duplicate: false });
  expect(accepted.acceptedRecordId).toEqual(expect.any(String));
  expect(
    (await native.reviewKnowledgeProposal(ctx.db, decision)).acceptedRecordId,
  ).toBe(accepted.acceptedRecordId);
  const repeatedAcceptance = await native.reviewKnowledgeProposal(ctx.db, {
    ...decision,
    proposalId: repeatedByOther.id,
    principal: { kind: "user", userId: otherReviewerId },
    idempotencyKey: "decision_other_reviewer_001",
  });

  expect(repeatedAcceptance.acceptedRecordId).toBe(accepted.acceptedRecordId);
  const records = await ctx.pool.query(
    "SELECT r.basis,r.attribution FROM brain_record_revisions r WHERE r.record_id=$1 AND r.revision=1",
    [accepted.acceptedRecordId],
  );

  expect(records.rows[0]).toMatchObject({
    basis: "inferred",
    attribution: { kind: "user", id: reviewerId, runId: null, attemptId: null },
  });
  expect(
    await ctx.pool.query(
      "SELECT id FROM brain_record_changes WHERE record_id=$1",
      [accepted.acceptedRecordId],
    ),
  ).toMatchObject({ rowCount: 1 });
  expect(
    await ctx.pool.query(
      "SELECT id FROM brain_confirmations WHERE record_id=$1",
      [accepted.acceptedRecordId],
    ),
  ).toMatchObject({ rowCount: 0 });
  const publishedEvents = await ctx.pool.query(
    "SELECT payload FROM domain_events WHERE kind='knowledge.record_changed' AND payload->>'recordId'=$1",
    [accepted.acceptedRecordId],
  );

  expect(publishedEvents.rows).toHaveLength(1);
  expect(publishedEvents.rows[0]?.payload).toMatchObject({
    owner: input.owner,
    cause: "published",
    recordId: accepted.acceptedRecordId,
    revision: 1,
    changeId: expect.any(String),
  });
  expect(JSON.stringify(publishedEvents.rows)).not.toContain(
    input.draft.assertion,
  );
  await expect(
    native.confirmKnowledgeRecord(ctx.db, {
      recordId: accepted.acceptedRecordId!,
      principal: input.principal,
      expectedRevision: 1,
      decision: "confirm",
      witnessIds: [],
      reason: "No evidence must not confirm a fact",
      idempotencyKey: "confirmation_example_001",
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
});

it("IT-CBK-05 deleting a project removes native proposals, revisions, confirmations and evidence without touching company knowledge", async () => {
  const native = await import("@/lib/brain/proposals");
  const reviewerId = randomUUID();
  const observationId = randomUUID();
  const witnessId = randomUUID();
  const companyRecordId = randomUUID();
  const companyId = (
    await ctx.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;

  await ctx.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [reviewerId, `${reviewerId}@example.test`],
  );
  await ctx.pool.query(
    "INSERT INTO brain_items(id,company_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'procedure','Company procedure',$3,$4,0.3)",
    [
      companyRecordId,
      companyId,
      `Independent company procedure ${companyRecordId}`,
      companyRecordId,
    ],
  );
  await ctx.pool.query(
    "INSERT INTO brain_evidence_observations(id,project_id,source_id,source_version,content_sha256,attribution) VALUES($1,$2,$3,'version-1',repeat('a',64),$4::jsonb)",
    [
      observationId,
      projectId,
      randomUUID(),
      JSON.stringify({
        kind: "user",
        id: reviewerId,
        runId: null,
        attemptId: null,
      }),
    ],
  );
  await ctx.pool.query(
    "INSERT INTO brain_evidence_witnesses(id,observation_id,source_version,content_sha256,selector,restrictions,capture_locator) VALUES($1,$2,'version-1',repeat('a',64),'service:health',$3::jsonb,$4::jsonb)",
    [
      witnessId,
      observationId,
      JSON.stringify([{ kind: "project", projectId }]),
      JSON.stringify({
        kind: "submitted_text",
        content: "Independent health check passed",
      }),
    ],
  );
  const principal = { kind: "user" as const, userId: reviewerId };
  const input = {
    owner: { kind: "project" as const, projectId },
    kind: "knowledge_add" as const,
    principal,
    idempotencyKey: "project_deletion_proposal_001",
    draft: {
      title: "Verified project procedure",
      kind: "procedure" as const,
      assertion: `Health is verified for ${projectId}`,
      basis: "observed" as const,
      evidence: [
        {
          relation: "supports" as const,
          reference: {
            kind: "witness" as const,
            id: witnessId,
            version: "version-1",
            sha256: "a".repeat(64),
          },
        },
      ],
      missingEvidence: [],
      limitations: [],
    },
  };
  const proposed = await createBrainProposal(ctx.db, input);
  const accepted = await native.reviewKnowledgeProposal(ctx.db, {
    proposalId: proposed.id,
    principal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Accept reviewed project procedure",
    idempotencyKey: "project_deletion_review_001",
  });
  const recordId = accepted.acceptedRecordId!;

  await expect(
    ctx.pool.query(
      "INSERT INTO brain_knowledge_submissions(company_id,proposal_id,principal_key,delivery_key,request_digest,attribution) VALUES($1,$2,'user:wrong-owner','invalid_cross_owner_alias',repeat('b',64),'{}')",
      [companyId, proposed.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_submission_owner_check",
  });

  await expect(
    ctx.pool.query(
      "INSERT INTO brain_record_revisions(record_id,revision,assertion,title,kind,basis,content_sha256,attribution,freshness,limitations,provenance,proposal_id) SELECT record_id,2,assertion,title,kind,basis,content_sha256,attribution,freshness,limitations,provenance,$2 FROM brain_record_revisions WHERE record_id=$1 AND revision=1",
      [companyRecordId, proposed.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "brain_proposal_record_owner_check",
  });

  const confirmed = await native.confirmKnowledgeRecord(ctx.db, {
    recordId,
    principal,
    expectedRevision: 1,
    decision: "confirm",
    witnessIds: [witnessId],
    reason: "Separate health check supports this revision",
    idempotencyKey: "project_deletion_confirm_001",
  });

  expect(confirmed.status).toBe("confirmed");
  const revoked = await native.confirmKnowledgeRecord(ctx.db, {
    recordId,
    principal,
    expectedRevision: 1,
    decision: "revoke",
    witnessIds: [],
    reason: "Revoke pending a revised procedure",
    idempotencyKey: "project_deletion_revoke_001",
  });

  expect(revoked.status).toBe("revoked");
  expect(
    (
      await ctx.pool.query(
        "SELECT decision FROM brain_confirmations WHERE record_id=$1 ORDER BY decision_sequence",
        [recordId],
      )
    ).rows,
  ).toEqual([{ decision: "confirm" }, { decision: "revoke" }]);

  const correction = await createBrainProposal(ctx.db, {
    ...input,
    kind: "knowledge_correct",
    targetRecordId: recordId,
    expectedRecordRevision: 1,
    idempotencyKey: "project_deletion_correction_001",
    draft: {
      ...input.draft,
      assertion: `Revised health procedure for ${projectId}`,
    },
  });

  await native.reviewKnowledgeProposal(ctx.db, {
    proposalId: correction.id,
    principal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Accept a second attributable revision",
    idempotencyKey: "project_deletion_review_002",
  });
  expect(
    (
      await ctx.pool.query(
        "SELECT revision FROM brain_record_revisions WHERE record_id=$1 ORDER BY revision",
        [recordId],
      )
    ).rows,
  ).toEqual([{ revision: 1 }, { revision: 2 }]);
  await ctx.pool.query("DELETE FROM projects WHERE id=$1", [projectId]);

  for (const table of [
    "brain_items",
    "brain_proposals",
    "brain_evidence_observations",
  ]) {
    expect(
      (
        await ctx.pool.query(`SELECT id FROM ${table} WHERE project_id=$1`, [
          projectId,
        ])
      ).rows,
    ).toEqual([]);
  }
  for (const table of [
    "brain_record_revisions",
    "brain_record_changes",
    "brain_confirmations",
    "brain_revision_evidence",
  ]) {
    expect(
      (
        await ctx.pool.query(
          `SELECT record_id FROM ${table} WHERE record_id=$1`,
          [recordId],
        )
      ).rows,
    ).toEqual([]);
  }
  expect(
    (
      await ctx.pool.query(
        "SELECT id FROM brain_evidence_witnesses WHERE id=$1",
        [witnessId],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await ctx.pool.query(
        "SELECT id,current_revision FROM brain_items WHERE id=$1",
        [companyRecordId],
      )
    ).rows,
  ).toEqual([{ id: companyRecordId, current_revision: 1 }]);
});

it("IT-CBK-02 concurrent corrections preserve one exact revision winner and require current review authority", async () => {
  const native = await import("@/lib/brain/proposals");
  const companyId = (
    await ctx.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;
  const userId = randomUUID();

  await ctx.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await ctx.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) SELECT $1,'user',$2,action,$2 FROM unnest(ARRAY['knowledge:read','knowledge:propose','knowledge:review']) action",
    [companyId, userId],
  );
  const principal = { kind: "user" as const, userId };
  const input = {
    owner: { kind: "company" as const, companyId },
    kind: "knowledge_add" as const,
    principal,
    idempotencyKey: "concurrent_native_base_001",
    draft: {
      title: "Correction race",
      kind: "decision" as const,
      assertion: `Initial decision ${userId}`,
      basis: "inferred" as const,
      evidence: [],
      missingEvidence: [
        {
          state: "unknown" as const,
          reason: "The decision has not been verified",
        },
      ],
      limitations: ["Provisional decision"],
    },
  };
  const original = await createBrainProposal(ctx.db, input);
  const accepted = await native.reviewKnowledgeProposal(ctx.db, {
    proposalId: original.id,
    principal,
    expectedRevision: 1,
    decision: "accept",
    reason: "Publish initial decision",
    idempotencyKey: "concurrent_native_accept_001",
  });
  const recordId = accepted.acceptedRecordId!;
  const proposals = await Promise.all(
    ["A", "B"].map((name) =>
      createBrainProposal(ctx.db, {
        ...input,
        kind: "knowledge_correct",
        targetRecordId: recordId,
        expectedRecordRevision: 1,
        idempotencyKey: `concurrent_correction_${name}`,
        draft: { ...input.draft, assertion: `Decision ${name} for ${userId}` },
      }),
    ),
  );
  const decisions = proposals.map((proposal) => ({
    proposalId: proposal.id,
    principal,
    expectedRevision: 1,
    decision: "accept" as const,
    reason: "Publish exact-base correction",
    idempotencyKey: `concurrent_review_${proposal.id}`,
  }));
  const results = await Promise.allSettled(
    decisions.map((decision) =>
      native.reviewKnowledgeProposal(ctx.db, decision),
    ),
  );

  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "CONFLICT" },
  });
  expect(
    (
      await ctx.pool.query(
        "SELECT revision,missing_evidence FROM brain_record_revisions WHERE record_id=$1 ORDER BY revision",
        [recordId],
      )
    ).rows,
  ).toEqual(
    [1, 2].map((revision) => ({
      revision,
      missing_evidence: input.draft.missingEvidence,
    })),
  );
  expect(
    (
      await ctx.pool.query(
        "SELECT id FROM brain_record_changes WHERE record_id=$1",
        [recordId],
      )
    ).rowCount,
  ).toBe(2);
  const winnerIndex = results.findIndex(
    (result) => result.status === "fulfilled",
  );
  const loserIndex = 1 - winnerIndex;

  expect(
    await native.reviewKnowledgeProposal(ctx.db, decisions[winnerIndex]!),
  ).toMatchObject({ duplicate: true, acceptedRecordId: recordId });
  await ctx.pool.query(
    "UPDATE company_grants SET revoked_at=now() WHERE company_id=$1 AND principal_id=$2 AND action='knowledge:review'",
    [companyId, userId],
  );
  await expect(
    native.reviewKnowledgeProposal(ctx.db, decisions[winnerIndex]!),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    native.reviewKnowledgeProposal(ctx.db, {
      ...decisions[loserIndex]!,
      decision: "reject",
    }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
