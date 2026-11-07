import type { HumanAssessmentWrite } from "@/lib/tasks/human-assessment-schema";

import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { tasks, taskQualifications, runs } from "@/lib/db/schema";
import { QUALIFICATION_DIMENSIONS } from "@/lib/tasks/qualification-types";
import {
  getHumanTaskAssessmentDraft,
  recordHumanTaskAssessment,
} from "@/lib/tasks/human-assessment";
import { updateTask } from "@/lib/services/tasks";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { git } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let fixture: Awaited<ReturnType<typeof seedTaskLaunchFixture>>;
let sequence = 0;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "human_assessment",
  });
  root = await mkdtempReal("human-assessment-");
  fixture = await seedTaskLaunchFixture(database, root);
  await writeFile(
    join(fixture.repo, "README.md"),
    "# Project\nA real repository reference.\n",
  );
  await git(fixture.repo, "add", "README.md");
  await git(fixture.repo, "commit", "-qm", "Document project scope");
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function task() {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Reviewed request",
    prompt: "Describe the observed behavior and acceptance criteria.",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
    launchIntent: "none",
  });

  return { taskId, projectId: fixture.projectId, userId: fixture.userId };
}

async function ready(
  scope: Awaited<ReturnType<typeof task>>,
): Promise<HumanAssessmentWrite> {
  const draft = await getHumanTaskAssessmentDraft(database.db, scope, {
    repository: true,
  });

  if (!draft.repository) throw new Error("Repository draft is required");

  return {
    requestKey: randomUUID(),
    contextToken: draft.contextToken,
    expectedInputRevision: draft.expectedInputRevision,
    expectedQualificationRevision: draft.expectedQualificationRevision,
    repositoryToken: draft.repository.token,
    requestType: "feature",
    decision: "ready",
    checks: QUALIFICATION_DIMENSIONS.map((dimension) => ({
      dimension,
      state: dimension === "bug_evidence" ? "not_applicable" : "pass",
      rationale:
        dimension === "bug_evidence"
          ? "This is a feature request."
          : "Reviewed the task against the project README.",
      evidenceIndexes: [0],
    })),
    evidence: [{ kind: "file", path: "README.md" }],
    nextActions: [],
  };
}

it("LA11 accepts genuine ready and held human assessments with generated evidence identities and no launch", async () => {
  const scope = await task();
  const request = await ready(scope);
  const receipt = await recordHumanTaskAssessment(database.db, scope, request);

  expect(receipt).toMatchObject({
    decision: "ready",
    publicationState: "accepted",
  });
  const [assessment] = await database.db
    .select()
    .from(taskQualifications)
    .where(eq(taskQualifications.id, receipt.qualificationId));

  expect(assessment.value.evidenceRefs).toEqual([
    {
      id: "evidence-1",
      kind: "repository",
      reference: expect.stringContaining("README.md"),
    },
  ]);
  expect(
    assessment.value.checks.find((check) => check.dimension === "relevance")
      ?.evidenceIds,
  ).toEqual(["evidence-1"]);
  expect(assessment.evidenceSha).toBe(
    await git(fixture.repo, "rev-parse", "HEAD"),
  );
  const heldScope = await task();
  const draft = await getHumanTaskAssessmentDraft(database.db, heldScope);
  const held = await recordHumanTaskAssessment(database.db, heldScope, {
    ...request,
    requestKey: randomUUID(),
    contextToken: draft.contextToken,
    expectedInputRevision: draft.expectedInputRevision,
    expectedQualificationRevision: draft.expectedQualificationRevision,
    repositoryToken: null,
    decision: "needs_information",
    evidence: [{ kind: "task", taskId: heldScope.taskId }],
    checks: request.checks.map((check) => ({
      ...check,
      state: "unknown",
      rationale: "The task needs a concrete acceptance example.",
    })),
    nextActions: ["Provide an input and expected output example."],
  });

  expect(held).toMatchObject({
    decision: "needs_information",
    publicationState: "accepted",
  });
  const runCount = await database.pool.query(
    "SELECT count(*)::int AS count FROM runs WHERE project_id=$1",
    [fixture.projectId],
  );

  expect(runCount.rows[0].count).toBe(0);
});

it("LA11 replays the original human receipt after input and HEAD drift, but rejects key payload changes", async () => {
  const scope = await task();
  const request = await ready(scope);
  const original = await recordHumanTaskAssessment(database.db, scope, request);

  await updateTask(
    scope.taskId,
    scope.projectId,
    { prompt: "Changed after assessment" },
    database.db,
  );
  await git(fixture.repo, "commit", "-q", "--allow-empty", "-m", "Move target");
  expect(await recordHumanTaskAssessment(database.db, scope, request)).toEqual(
    original,
  );
  await expect(
    recordHumanTaskAssessment(database.db, scope, {
      ...request,
      nextActions: ["Changed payload"],
    }),
  ).rejects.toMatchObject({
    details: { reason: "qualification_request_conflict" },
  });
  await expect(
    prepareTaskQualification(database.db, {
      projectId: scope.projectId,
      taskId: scope.taskId,
      author: { kind: "user", identity: scope.userId, userId: scope.userId },
      request: {
        requestKey: request.requestKey,
        expectedInputRevision: request.expectedInputRevision,
        expectedQualificationRevision: request.expectedQualificationRevision,
        qualification: qualificationFixture(),
      },
    }),
  ).rejects.toMatchObject({
    details: { reason: "qualification_request_conflict" },
  });
});

it("LA11 resolves real run references and rejects foreign task/run and untracked file selections", async () => {
  const scope = await task();
  const request = await ready(scope);
  const runId = randomUUID();

  await database.db.insert(runs).values({
    id: runId,
    projectId: scope.projectId,
    runKind: "agent",
    flowVersion: "agent",
    status: "Done",
  });
  const receipt = await recordHumanTaskAssessment(database.db, scope, {
    ...request,
    decision: "needs_review",
    repositoryToken: null,
    evidence: [{ kind: "run", runId }],
    nextActions: ["Review the existing execution result."],
  });
  const [stored] = await database.db
    .select()
    .from(taskQualifications)
    .where(eq(taskQualifications.id, receipt.qualificationId));

  expect(stored.value.evidenceRefs).toEqual([
    { id: "evidence-1", kind: "run", reference: `run:${runId}` },
  ]);
  const foreignProject = randomUUID();
  const foreignTask = randomUUID();
  const foreignRun = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES($1,$1,'Foreign',$2,'FOREIGN')",
    [foreignProject, join(root, "foreign")],
  );
  await database.db.insert(tasks).values({
    id: foreignTask,
    projectId: foreignProject,
    number: 1,
    title: "Private other task",
    prompt: "Private other prompt",
  });
  await database.db.insert(runs).values({
    id: foreignRun,
    projectId: foreignProject,
    runKind: "agent",
    flowVersion: "agent",
    status: "Done",
  });
  for (const selection of [
    { kind: "task", taskId: foreignTask },
    { kind: "run", runId: foreignRun },
  ] as const) {
    const candidateScope = await task();
    const candidate = await ready(candidateScope);

    await expect(
      recordHumanTaskAssessment(database.db, candidateScope, {
        ...candidate,
        decision: "needs_review",
        repositoryToken: null,
        evidence: [selection],
        nextActions: ["Inspect available project evidence."],
      }),
    ).rejects.toMatchObject({
      details: { reason: "human_assessment_evidence_unavailable" },
    });
  }
  const fileScope = await task();
  const fileRequest = await ready(fileScope);

  await expect(
    recordHumanTaskAssessment(database.db, fileScope, {
      ...fileRequest,
      evidence: [{ kind: "file", path: "untracked-secret.txt" }],
    }),
  ).rejects.toMatchObject({
    details: { reason: "human_assessment_evidence_unavailable" },
  });
});

it("LA11 refuses stale context, stale repository evidence and invalid cross-project source selectors", async () => {
  const scope = await task();
  const request = await ready(scope);

  await git(
    fixture.repo,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "New source evidence",
  );
  await expect(
    recordHumanTaskAssessment(database.db, scope, request),
  ).rejects.toMatchObject({ details: { reason: "qualification_stale" } });
  const current = await ready(scope);

  await expect(
    recordHumanTaskAssessment(database.db, scope, {
      ...current,
      evidence: [{ kind: "task", taskId: randomUUID() }],
      decision: "not_actionable",
      nextActions: ["Review a related request."],
    }),
  ).rejects.toMatchObject({
    details: { reason: "human_assessment_evidence_unavailable" },
  });
  await updateTask(
    scope.taskId,
    scope.projectId,
    { prompt: "Changed while authoring" },
    database.db,
  );
  await expect(
    recordHumanTaskAssessment(database.db, scope, current),
  ).rejects.toMatchObject({ details: { reason: "qualification_stale" } });
});

it("LA11 refuses revoked repository access and reports exact actionable validation paths", async () => {
  const scope = await task();
  const request = await ready(scope);

  await expect(
    recordHumanTaskAssessment(database.db, scope, {
      ...request,
      checks: request.checks.map((check) =>
        check.dimension === "relevance"
          ? { ...check, evidenceIndexes: [] }
          : check,
      ),
    }),
  ).rejects.toMatchObject({
    code: "CONFIG",
    details: { issues: [{ path: "evidence", key: "repository" }] },
  });
  const viewerId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'viewer','active',false)",
    [viewerId, `${viewerId}@test.local`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'viewer')",
    [randomUUID(), fixture.projectId, viewerId],
  );
  await expect(
    recordHumanTaskAssessment(
      database.db,
      { ...scope, userId: viewerId },
      request,
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

it("LA11 joins simultaneous identical authoring and refuses receipt replay after the author's grant is revoked", async () => {
  const scope = await task();
  const request = await ready(scope);
  const [first, repeated] = await Promise.all([
    recordHumanTaskAssessment(database.db, scope, request),
    recordHumanTaskAssessment(database.db, scope, request),
  ]);

  expect(repeated).toEqual(first);
  const memberId = randomUUID();
  const memberScope = { ...(await task()), userId: memberId };

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'member','active',false)",
    [memberId, `${memberId}@test.local`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'member')",
    [randomUUID(), scope.projectId, memberId],
  );
  const memberRequest = await ready(memberScope);

  await recordHumanTaskAssessment(database.db, memberScope, memberRequest);
  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
    [scope.projectId, memberId],
  );
  await expect(
    recordHumanTaskAssessment(database.db, memberScope, memberRequest),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
