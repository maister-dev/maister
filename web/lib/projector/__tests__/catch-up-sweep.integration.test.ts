import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { runProjectorCatchUpSweep } from "@/lib/projector/catch-up-sweep";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: any;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "canonical_projector_catchup_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.delete(schema.executionEventConsumers);
  await db.delete(schema.runs);
  await db.delete(schema.projects);
});

async function seedRun(status: string): Promise<string> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const slug = `catchup-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status,
    executionDataPlaneMode: "canonical_events_v1",
    flowVersion: "v1",
    flowRevision: "test",
  });

  return runId;
}

describe("runProjectorCatchUpSweep", () => {
  it("visits in-flight canonical runs without requiring a runtime filesystem", async () => {
    await seedRun("Running");
    await seedRun("Review");
    await seedRun("Done");

    const summary = await runProjectorCatchUpSweep({ db });

    expect(summary).toEqual({ candidatesFound: 2, projected: 0 });
  });

  it("honors its bounded candidate limit", async () => {
    await seedRun("Running");
    await seedRun("NeedsInput");
    await seedRun("HumanWorking");

    const summary = await runProjectorCatchUpSweep({ db, limit: 2 });

    expect(summary.candidatesFound).toBe(2);
  });
});
