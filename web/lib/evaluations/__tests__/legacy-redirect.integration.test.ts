import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { resolveLegacyExperimentStudyId } from "@/lib/evaluations/legacy-redirect";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;

let projectId: string;
let otherProjectId: string;
let studyId: string;

const LEGACY_ID = "legacy-exp-1";

async function seedProjectWithTask(): Promise<{ id: string; taskId: string }> {
  const id = randomUUID();
  const taskId = randomUUID();

  await db.insert(schema.projects).values({
    id,
    slug: `proj-${id.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${id.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `T${id
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 7)
      .toUpperCase()}`,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    number: 1,
    projectId: id,
    title: "t",
    prompt: "p",
  });

  return { id, taskId };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_legacy_redirect_test",
  });
  db = testDatabase.db;

  const target = await seedProjectWithTask();
  const other = await seedProjectWithTask();

  projectId = target.id;
  otherProjectId = other.id;
  studyId = randomUUID();

  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId: target.taskId,
    title: "backfilled study",
    status: "open",
    legacyExperimentId: LEGACY_ID,
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("resolveLegacyExperimentStudyId — deep-link contract (ADR-150 T4.1)", () => {
  it("resolves a known legacy experiment id to its backfilled study", async () => {
    expect(
      await resolveLegacyExperimentStudyId(projectId, LEGACY_ID, db as never),
    ).toBe(studyId);
  });

  it("returns null for an unknown legacy experiment id (→ evaluations list)", async () => {
    expect(
      await resolveLegacyExperimentStudyId(
        projectId,
        "never-migrated",
        db as never,
      ),
    ).toBeNull();
  });

  it("does not leak across projects: the right id under the wrong project resolves null", async () => {
    expect(
      await resolveLegacyExperimentStudyId(
        otherProjectId,
        LEGACY_ID,
        db as never,
      ),
    ).toBeNull();
  });
});
