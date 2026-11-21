import { expect, it, vi } from "vitest";

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
        href: expect.stringContaining(`/flows/${project.slug}/`),
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
