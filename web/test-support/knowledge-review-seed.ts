import type { StartedPostgresTestDb } from "./pg-container";

import { addProjectMember, seedActiveUser } from "./librarian-seed";
import { seedProjectRow } from "./execution-host-seed";

import { createBrainProposal } from "@/lib/brain/proposals";

/** Project review fixture with tied timestamps and one inaccessible source. */
export async function seedProjectReviewQueue(fixture: StartedPostgresTestDb) {
  const project = await seedProjectRow(fixture.db);
  const privateProject = await seedProjectRow(fixture.db);
  const userId = await seedActiveUser(fixture.db);

  await addProjectMember(fixture.db, {
    projectId: project.id,
    userId,
    role: "admin",
  });
  await fixture.pool.query(
    "UPDATE projects SET brain_enabled = TRUE WHERE id = $1",
    [project.id],
  );

  const proposals = [];

  for (let index = 1; index <= 27; index++) {
    const proposal = await createBrainProposal(fixture.db, {
      projectId: project.id,
      kind: "state",
      evidenceItemIds: [],
      draft: {
        title: `Queue fixture ${index}`,
        path: "docs/review.md",
        content: "Review the current retained source.",
      },
      blastRadius: "low",
      autonomyDecision: "manual",
      actor: { type: "user", id: userId },
    });

    proposals.push(proposal.id);
  }

  const restrictedId = proposals.pop()!;

  await fixture.pool.query(
    "UPDATE brain_proposals SET created_at = '2026-01-01T00:00:00Z' WHERE project_id = $1",
    [project.id],
  );
  await fixture.pool.query(
    "UPDATE brain_proposals SET source_restrictions = $2::jsonb WHERE id = $1",
    [
      restrictedId,
      JSON.stringify([
        { kind: "project_context", projectId: privateProject.id },
      ]),
    ],
  );

  return {
    project,
    userId,
    expectedIds: proposals.sort().reverse(),
    restrictedId,
  };
}
