import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { openReview, resolveReview } from "@/lib/evaluations/reviews";
import { listVerdicts, recordVerdict } from "@/lib/evaluations/verdicts";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let userId: string;

async function makeStudy(): Promise<{
  studyId: string;
  completed: string;
  partial: string;
  queued: string;
}> {
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  const flowId = randomUUID();

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });

  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  const studyId = randomUUID();

  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "Study",
    status: "open",
  });

  const [completed, partial, queued] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];

  await db.insert(schema.evaluationExecutions).values([
    { id: completed, studyId, status: "completed" },
    { id: partial, studyId, status: "partial" },
    { id: queued, studyId, status: "queued" },
  ]);

  return { studyId, completed, partial, queued };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_verdicts_test",
  });
  db = testDatabase.db;

  userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId.slice(0, 8)}@x.io`,
    role: "member",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("recordVerdict (append-only, human-only)", () => {
  it("records a verdict citing a completed execution and flips the study to decided", async () => {
    const s = await makeStudy();

    const res = await recordVerdict(
      {
        studyId: s.studyId,
        outcome: "winner",
        participantIds: ["p1"],
        executionIds: [s.completed],
        createdByUserId: userId,
      },
      db,
    );

    expect(res.sequence).toBeGreaterThan(0);

    const [study] = await db
      .select({ status: schema.evaluationStudies.status })
      .from(schema.evaluationStudies)
      .where(eq(schema.evaluationStudies.id, s.studyId));

    expect(study.status).toBe("decided");

    const events = await db
      .select({ eventType: schema.evaluationEvents.eventType })
      .from(schema.evaluationEvents)
      .where(eq(schema.evaluationEvents.studyId, s.studyId));

    expect(events.map((e: any) => e.eventType)).toContain("verdict.recorded");

    // Social-board mirror: the study's task timeline reflects the conclusion in
    // the same transaction (ADR-078), with bounded metadata only.
    const [studyRow] = await db
      .select({ taskId: schema.evaluationStudies.taskId })
      .from(schema.evaluationStudies)
      .where(eq(schema.evaluationStudies.id, s.studyId));
    const activity = await db
      .select({
        eventKind: schema.taskActivity.eventKind,
        actorType: schema.taskActivity.actorType,
        payload: schema.taskActivity.payload,
      })
      .from(schema.taskActivity)
      .where(eq(schema.taskActivity.taskId, studyRow.taskId));

    expect(activity).toHaveLength(1);
    expect(activity[0].eventKind).toBe("evaluation_decided");
    expect(activity[0].actorType).toBe("user");
    expect(activity[0].payload).toMatchObject({ outcome: "winner" });
  });

  it("refuses a zero-citation verdict without the acknowledgement", async () => {
    const s = await makeStudy();

    await expect(
      recordVerdict(
        {
          studyId: s.studyId,
          outcome: "inconclusive",
          participantIds: [],
          executionIds: [],
          createdByUserId: userId,
        },
        db,
      ),
    ).rejects.toThrow(/no-evaluation-evidence acknowledgement/);
  });

  it("allows a zero-citation verdict WITH the acknowledgement", async () => {
    const s = await makeStudy();

    await expect(
      recordVerdict(
        {
          studyId: s.studyId,
          outcome: "inconclusive",
          participantIds: [],
          executionIds: [],
          noEvaluationEvidenceAck: true,
          createdByUserId: userId,
        },
        db,
      ),
    ).resolves.toBeTruthy();
  });

  it("refuses citing a non-terminal (queued) execution", async () => {
    const s = await makeStudy();

    await expect(
      recordVerdict(
        {
          studyId: s.studyId,
          outcome: "winner",
          participantIds: ["p1"],
          executionIds: [s.queued],
          createdByUserId: userId,
        },
        db,
      ),
    ).rejects.toThrow(/only Completed or terminal Partial/);
  });

  it("requires acknowledged warnings when citing a Partial execution", async () => {
    const s = await makeStudy();

    await expect(
      recordVerdict(
        {
          studyId: s.studyId,
          outcome: "winner",
          participantIds: ["p1"],
          executionIds: [s.partial],
          createdByUserId: userId,
        },
        db,
      ),
    ).rejects.toThrow(/comparability warnings/);

    await expect(
      recordVerdict(
        {
          studyId: s.studyId,
          outcome: "winner",
          participantIds: ["p1"],
          executionIds: [s.partial],
          acknowledgedWarnings: ["incomplete_coverage"],
          createdByUserId: userId,
        },
        db,
      ),
    ).resolves.toBeTruthy();
  });

  it("supersedes a prior verdict only with a rationale", async () => {
    const s = await makeStudy();

    const first = await recordVerdict(
      {
        studyId: s.studyId,
        outcome: "winner",
        participantIds: ["p1"],
        executionIds: [s.completed],
        createdByUserId: userId,
      },
      db,
    );

    await expect(
      recordVerdict(
        {
          studyId: s.studyId,
          outcome: "tie",
          participantIds: ["p1", "p2"],
          executionIds: [s.completed],
          supersedesId: first.id,
          createdByUserId: userId,
        },
        db,
      ),
    ).rejects.toThrow(/rationale/);

    await recordVerdict(
      {
        studyId: s.studyId,
        outcome: "tie",
        participantIds: ["p1", "p2"],
        executionIds: [s.completed],
        supersedesId: first.id,
        rationale: "re-reviewed the evidence",
        createdByUserId: userId,
      },
      db,
    );

    const verdicts = await listVerdicts(s.studyId, db);

    expect(verdicts).toHaveLength(2);
  });
});

describe("reviews (CAS resolve)", () => {
  it("opens then resolves a review, and 409s a stale revision", async () => {
    const s = await makeStudy();
    const review = await openReview(
      { studyId: s.studyId, executionId: s.completed, kind: "disagreement" },
      db,
    );

    await resolveReview(
      {
        reviewId: review.id,
        expectedRevision: 1,
        reviewerUserId: userId,
        resolution: "kept panel result",
        studyId: s.studyId,
      },
      db,
    );

    await expect(
      resolveReview(
        {
          reviewId: review.id,
          expectedRevision: 1,
          reviewerUserId: userId,
          resolution: "again",
          studyId: s.studyId,
        },
        db,
      ),
    ).rejects.toThrow(/not required@v1/);
  });
});
