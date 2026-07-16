import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  addObservedParticipants,
  createRecipe,
  createStudy,
  patchStudy,
  removeParticipant,
} from "@/lib/evaluations/studies";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

let projectId: string;
let otherProjectId: string;
let executorId: string;
let flowId: string;
let taskId: string;
let otherTaskId: string;

async function makeRun(
  task: string,
  project: string,
  runKind = "flow",
): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    taskId: task,
    projectId: project,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    runKind,
  });

  return runId;
}

async function makeTask(project: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id,
    projectId: project,
    title: "T",
    prompt: "p",
    flowId,
  });

  return id;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_studies_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  otherProjectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();

  for (const [pid, slug] of [
    [projectId, "proj"],
    [otherProjectId, "other"],
  ] as const) {
    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: pid,
      slug: `${slug}-${pid.slice(0, 8)}`,
      name: slug,
      repoPath: `/tmp/${slug}-${pid.slice(0, 8)}`,
      maisterYamlPath: "/tmp/m.yaml",
    });
  }
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
    schemaVersion: 1,
  });
  taskId = await makeTask(projectId);
  otherTaskId = await makeTask(projectId);
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("createStudy", () => {
  it("creates a draft study bound to the project + task", async () => {
    const study = await createStudy(
      { projectId, taskId, title: "S1", purpose: "compare" },
      db,
    );

    expect(study.status).toBe("draft");
    expect(study.version).toBe(1);
    expect(study.projectId).toBe(projectId);
  });

  it("rejects a task that does not belong to the project", async () => {
    const foreignTask = await makeTask(otherProjectId);

    await expect(
      createStudy({ projectId, taskId: foreignTask, title: "bad" }, db),
    ).rejects.toThrow(/not found in project/);
  });
});

describe("addObservedParticipants", () => {
  it("adds observed participants, flips draft->open, and is idempotent", async () => {
    const study = await createStudy({ projectId, taskId, title: "S2" }, db);
    const runId = await makeRun(taskId, projectId);

    const first = await addObservedParticipants(
      { studyId: study.id as string, runIds: [runId, runId] },
      db,
    );

    // Deduped to one participant.
    expect(first).toHaveLength(1);
    expect(first[0].sourceType).toBe("observed");
    expect(first[0].runIdentity).toBeTruthy();

    // Second add of the same run is idempotent (returns the existing row).
    const again = await addObservedParticipants(
      { studyId: study.id as string, runIds: [runId] },
      db,
    );

    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(first[0].id);
  });

  it("flips the study status to open on the first participant", async () => {
    const study = await createStudy({ projectId, taskId, title: "S2b" }, db);
    const runId = await makeRun(taskId, projectId);

    await addObservedParticipants(
      { studyId: study.id as string, runIds: [runId] },
      db,
    );
    const [reloaded] = await db
      .select({ status: schema.evaluationStudies.status })
      .from(schema.evaluationStudies)
      .where(eq(schema.evaluationStudies.id, study.id));

    expect(reloaded.status).toBe("open");
  });

  it("rejects a run from another task/project", async () => {
    const study = await createStudy({ projectId, taskId, title: "S3" }, db);
    const otherTaskRun = await makeRun(otherTaskId, projectId);

    await expect(
      addObservedParticipants(
        { studyId: study.id as string, runIds: [otherTaskRun] },
        db,
      ),
    ).rejects.toThrow(/does not belong/);
  });

  it("rejects a non-flow run", async () => {
    const study = await createStudy({ projectId, taskId, title: "S4" }, db);
    const scratchRun = await makeRun(taskId, projectId, "scratch");

    await expect(
      addObservedParticipants(
        { studyId: study.id as string, runIds: [scratchRun] },
        db,
      ),
    ).rejects.toThrow(/not a flow run/);
  });

  it("allows the same observed run in multiple studies", async () => {
    const runId = await makeRun(taskId, projectId);
    const a = await createStudy({ projectId, taskId, title: "SA" }, db);
    const b = await createStudy({ projectId, taskId, title: "SB" }, db);

    const inA = await addObservedParticipants(
      { studyId: a.id as string, runIds: [runId] },
      db,
    );
    const inB = await addObservedParticipants(
      { studyId: b.id as string, runIds: [runId] },
      db,
    );

    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(1);
    expect(inA[0].id).not.toBe(inB[0].id);
  });
});

describe("patchStudy", () => {
  it("updates on a matching version and bumps it; rejects a stale version", async () => {
    const study = await createStudy({ projectId, taskId, title: "S5" }, db);

    const patched = await patchStudy(
      { studyId: study.id as string, expectedVersion: 1, title: "S5-renamed" },
      db,
    );

    expect(patched.title).toBe("S5-renamed");
    expect(patched.version).toBe(2);

    await expect(
      patchStudy(
        { studyId: study.id as string, expectedVersion: 1, title: "stale" },
        db,
      ),
    ).rejects.toThrow(/version mismatch/);
  });
});

describe("createRecipe", () => {
  it("creates an immutable recipe with a digest; rejects a duplicate key", async () => {
    const study = await createStudy({ projectId, taskId, title: "S6" }, db);

    const recipe = await createRecipe(
      {
        studyId: study.id as string,
        key: "variant-a",
        label: "A",
        definition: { runnerId: "x" },
      },
      db,
    );

    expect(recipe.definitionDigest).toBeTruthy();

    await expect(
      createRecipe(
        {
          studyId: study.id as string,
          key: "variant-a",
          label: "A2",
          definition: { runnerId: "y" },
        },
        db,
      ),
    ).rejects.toThrow(/already exists/);
  });
});

describe("removeParticipant", () => {
  it("hard-deletes an unreferenced participant and tombstones a referenced one", async () => {
    const study = await createStudy({ projectId, taskId, title: "S7" }, db);
    const runId = await makeRun(taskId, projectId);
    const [participant] = await addObservedParticipants(
      { studyId: study.id as string, runIds: [runId] },
      db,
    );

    // Unreferenced -> hard delete.
    const del = await removeParticipant(
      { studyId: study.id as string, participantId: participant.id as string },
      db,
    );

    expect(del.tombstoned).toBe(false);

    // A referenced participant (cited by a sealed evidence item) -> tombstone.
    const runId2 = await makeRun(taskId, projectId);
    const [p2] = await addObservedParticipants(
      { studyId: study.id as string, runIds: [runId2] },
      db,
    );
    const snapshotId = randomUUID();

    await db.insert(schema.evaluationEvidenceSnapshots).values({
      id: snapshotId,
      studyId: study.id,
      status: "sealed",
      participantWatermarks: {},
      evidenceProtocolDigest: "d",
    });
    await db.insert(schema.evaluationEvidenceItems).values({
      id: randomUUID(),
      snapshotId,
      participantId: p2.id,
      kind: "diff",
      locator: "x",
      digest: "d",
      coverageClass: "captured",
    });

    const tomb = await removeParticipant(
      { studyId: study.id as string, participantId: p2.id as string },
      db,
    );

    expect(tomb.tombstoned).toBe(true);
  });
});
