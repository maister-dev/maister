import type { KnowledgeDraft } from "@/lib/brain/knowledge-types";

import { expect, it, vi } from "vitest";

import { inspectKnowledgeProposal } from "@/lib/brain/knowledge-proposal-read";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";
import { createBrainProposal } from "@/lib/brain/proposals";
import {
  decideProposalReview,
  getProposalReviewDetail,
} from "@/lib/queries/inbox-review-actions";
import {
  listProposalReviews,
  parseReviewFilters,
} from "@/lib/queries/knowledge-memory-reviews";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { seedProjectReviewQueue } from "@/test-support/knowledge-review-seed";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

it("K02, K04 count and page the same authorized selection and permit an off-page lookup", async () => {
  const fixture = await startMainAndBrainPostgresTestDb({
    databaseName: "knowledge_review_queue",
  });

  vi.stubEnv("AUTH_SECRET", "knowledge-review-queue-test");

  try {
    const { project, userId, expectedIds, restrictedId } =
      await seedProjectReviewQueue(fixture);
    const selection = { projectId: project.id, limit: "20" };
    const list = (cursor?: string) =>
      listProposalReviews(
        fixture.db,
        userId,
        parseReviewFilters({ ...selection, ...(cursor && { cursor }) }),
      );
    const first = await list();

    expect(first).toMatchObject({ total: 26, nextCursor: expect.any(String) });
    const second = await list(first.nextCursor!);

    expect(second).toMatchObject({ total: 26, nextCursor: null });
    expect([...first.items, ...second.items].map(({ id }) => id)).toEqual(
      expectedIds,
    );
    const offPage = { kind: "brain", id: expectedIds.at(-1)! } as const;
    const open = () => getProposalReviewDetail(fixture.db, userId, offPage);

    expect(await open()).toMatchObject({
      id: offPage.id,
      domainState: "pending",
      detail: { origin: "ordinary", expectedEffect: "project_task" },
    });
    await expect(
      getProposalReviewDetail(fixture.db, userId, {
        kind: "brain",
        id: restrictedId,
      }),
    ).rejects.toMatchObject({
      details: { reason: "agent_memory_unavailable" },
    });

    await fixture.pool.query(
      "UPDATE brain_proposals SET status='rejected',resolved_at=now(), resolution=$2::jsonb WHERE id=$1",
      [
        offPage.id,
        JSON.stringify({
          actor: { type: "user", id: userId },
          reason: "Fixture rejection",
        }),
      ],
    );
    const history = await listProposalReviews(
      fixture.db,
      userId,
      parseReviewFilters({ projectId: project.id, view: "history" }),
    );

    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({ id: offPage.id, allowed: [] });
    expect(await open()).toMatchObject({
      id: offPage.id,
      domainState: "rejected",
      outcome: { type: "rejected", proposalId: offPage.id },
    });
    const authored = await createBrainProposal(fixture.db, {
      projectId: project.id,
      kind: "rule",
      draft: {
        slug: "reviewed-rule",
        title: "Reviewed project rule",
        body: { markdown: "Review a change before publishing it." },
      },
      blastRadius: "low",
      autonomyDecision: "manual",
      evidenceItemIds: [],
      actor: { type: "user", id: userId },
    });
    const catalogItem = { kind: "brain", id: authored.id } as const;

    await fixture.pool.query(
      "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
      [project.id, userId],
    );
    const refreshed = await list();

    expect(refreshed.items[0]).toMatchObject({
      id: authored.id,
      allowed: ["reject"],
    });
    const inspected = await getProposalReviewDetail(
      fixture.db,
      userId,
      catalogItem,
    );
    const decision = {
      ...catalogItem,
      decision: "accept",
      expectedVersion: inspected.version,
      requestKey: "project-draft-review",
    } as const;

    await expect(
      decideProposalReview(fixture.db, userId, decision),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "agent_memory_unavailable" },
    });
    const editor = await seedActiveUser(fixture.db);

    await addProjectMember(fixture.db, {
      projectId: project.id,
      userId: editor,
      role: "admin",
    });
    const accepted = await decideProposalReview(fixture.db, editor, decision);

    expect(accepted).toMatchObject({
      domainState: "applied",
      outcome: {
        type: "catalog_draft",
        draftId: expect.any(String),
        href: `/projects/${project.slug}/brain/proposals/${authored.id}/draft`,
      },
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT cap.lifecycle,cap.current_published_revision_id,b.task_id FROM brain_proposals b JOIN authored_capabilities cap ON cap.id=b.authored_draft_id AND cap.project_id=b.project_id WHERE b.id=$1",
          [authored.id],
        )
      ).rows,
    ).toEqual([
      {
        lifecycle: "DRAFT",
        current_published_revision_id: null,
        task_id: null,
      },
    ]);

    await removeProjectMember(fixture.db, { projectId: project.id, userId });
    expect(await list(first.nextCursor!)).toMatchObject({
      items: [],
      total: 0,
    });
    await expect(open()).rejects.toMatchObject({
      details: { reason: "agent_memory_unavailable" },
    });
  } finally {
    vi.unstubAllEnvs();
    await fixture.stop();
  }
}, 180_000);

it("K04 removes correction acceptance when the record review grant is revoked and preserves rejection", async () => {
  const fixture = await startMainAndBrainPostgresTestDb({
    databaseName: "restricted_correction_authority",
  });

  try {
    const project = await seedProjectRow(fixture.db);
    const userId = await seedActiveUser(fixture.db);
    const principal = { kind: "user", userId } as const;
    const owner = { kind: "project", projectId: project.id } as const;
    const draft: KnowledgeDraft = {
      title: "Original guidance",
      kind: "decision",
      assertion: "Use the previously approved path.",
      basis: "inferred",
      evidence: [],
      missingEvidence: [{ state: "unknown", reason: "Source not retained" }],
      limitations: [],
    };

    await fixture.pool.query(
      "UPDATE projects SET brain_enabled=true WHERE id=$1",
      [project.id],
    );
    await addProjectMember(fixture.db, {
      projectId: project.id,
      userId,
      role: "admin",
    });
    const original = await createKnowledgeProposal(fixture.db, {
      kind: "knowledge_add",
      owner,
      principal,
      draft,
      idempotencyKey: "restricted-correction-base",
    });
    const publication = await reviewKnowledgeProposal(fixture.db, {
      proposalId: original.id,
      principal,
      expectedRevision: original.revision,
      decision: "accept",
      reason: "Publish the original record",
      idempotencyKey: "restricted-correction-publication",
    });
    const recordId = publication.acceptedRecordId!;
    const correction = await createKnowledgeProposal(fixture.db, {
      kind: "knowledge_correct",
      owner,
      principal,
      targetRecordId: recordId,
      expectedRecordRevision: 1,
      draft: { ...draft, assertion: "Use the newly proposed path." },
      idempotencyKey: "restricted-correction-proposal",
    });

    await fixture.pool.query(
      `INSERT INTO brain_record_grants(record_id,principal_type,principal_id,action,created_by)
       SELECT $1,'user',$2,action,jsonb_build_object('kind','user','id',$2::text,'runId',null,'attemptId',null)
       FROM unnest(ARRAY['knowledge:read','knowledge:review']) action`,
      [recordId, userId],
    );
    const selection = { kind: "knowledge", id: correction.id } as const;
    const detail = () => getProposalReviewDetail(fixture.db, userId, selection);

    expect(await detail()).toMatchObject({ allowed: ["accept", "reject"] });
    await fixture.pool.query(
      "UPDATE brain_record_grants SET revoked_at=now() WHERE record_id=$1 AND principal_id=$2 AND action='knowledge:review'",
      [recordId, userId],
    );

    expect(await detail()).toMatchObject({ allowed: ["reject"] });
    expect(
      await inspectKnowledgeProposal(fixture.db, principal, correction.id),
    ).toMatchObject({ canReview: true });
    expect(
      await listProposalReviews(fixture.db, userId, {
        kind: "knowledge",
        projectId: project.id,
        limit: 20,
      }),
    ).toMatchObject({ items: [{ id: correction.id, allowed: ["reject"] }] });
    const decision = {
      ...selection,
      expectedVersion: String(correction.revision),
      requestKey: "restricted-correction-settlement",
      reason: "Reject without publication authority",
    };

    await expect(
      decideProposalReview(fixture.db, userId, {
        ...decision,
        decision: "accept",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "knowledge_reference_unavailable" },
    });
    await expect(
      decideProposalReview(fixture.db, userId, {
        ...decision,
        decision: "reject",
      }),
    ).resolves.toMatchObject({ domainState: "rejected" });
    expect(
      (
        await fixture.pool.query(
          "SELECT current_revision FROM brain_items WHERE id=$1",
          [recordId],
        )
      ).rows,
    ).toEqual([{ current_revision: 1 }]);
  } finally {
    await fixture.stop();
  }
}, 180_000);
