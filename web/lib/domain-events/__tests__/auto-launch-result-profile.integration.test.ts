import type { RunResultContract } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type DelegationSeedCtx,
  resetDelegationFixture,
  seedAgent,
  seedFlow,
  seedOrchestratorRun,
  seedTask,
} from "@/test-support/delegation-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let ctx: DelegationSeedCtx;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let resolveResultContractForDelegation: typeof import("@/lib/run-results/resolve-profile").resolveResultContractForDelegation;

const PROFILE_SCHEMA = {
  schemaVersion: 1,
  fields: [{ name: "summary", type: "string", required: true }],
};

function profileMap(name: string): Record<string, unknown> {
  return {
    [name]: {
      schemaPath: "./schemas/research-result.v1.json",
      schemaStem: "research-result.v1",
      schemaVersion: 1,
      sha256: "c".repeat(64),
      schema: PROFILE_SCHEMA,
    },
  };
}

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-auto-profile-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "auto_launch_result_profile_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ resolveResultContractForDelegation } = await import(
    "@/lib/run-results/resolve-profile"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  ctx = await resetDelegationFixture({ pool, db, agentsRoot });
});

/**
 * A parked orchestrator pinned to a revision whose package declares `research`.
 * Returns the parent run id — the auto-launcher's THIRD creation edge resolves
 * a dependent's `delegation_spec.resultProfile` against exactly this pin.
 */
async function seedPinnedParent(args: {
  profiles?: Record<string, unknown> | null;
  engineMin?: string;
}): Promise<string> {
  const seeded = await seedFlow(ctx, {
    flowRefId: "parent-pkg",
    engineMin: args.engineMin ?? "3.7.0",
  });

  if (args.profiles !== null) {
    await pool.query(
      `UPDATE "flow_revisions" SET "result_profiles" = $2::jsonb WHERE "id" = $1`,
      [
        seeded.revisionId,
        JSON.stringify(args.profiles ?? profileMap("research")),
      ],
    );
  }

  const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
  const task = await seedTask(ctx);
  const run = await seedOrchestratorRun(ctx, {
    orchestratorAgentId: orchestrator,
    taskId: task.id,
    issueToken: issueOrchestratorRunToken,
  });

  await pool.query(`UPDATE "runs" SET "flow_revision_id" = $2 WHERE id = $1`, [
    run.runId,
    seeded.revisionId,
  ]);

  return run.runId;
}

// ADR-165 AC-20 / spec C-5.5-C-5.6. The as-plan auto-launcher is the THIRD
// creation edge, and it launches LONG after the plan was submitted — possibly
// after the package moved. It re-resolves the recorded NAME against the parent's
// PINNED revision, which is what makes a profile deleted upstream still resolve.

describe("auto-launch edge — profile resolution against the pinned revision", () => {
  it("resolves the recorded name into the same contract the source launch got", async () => {
    const parentRunId = await seedPinnedParent({});

    const contract = (await resolveResultContractForDelegation(db, {
      parentRunId,
      name: "research",
    })) as RunResultContract;

    expect(contract).toMatchObject({
      kind: "agent_profile",
      profileName: "research",
      required: true,
      schemaRef: "parent-pkg@rev-parent-p:research-result.v1",
    });
  });

  it("still resolves after a NEWER revision drops the profile — the pin is what counts", async () => {
    const parentRunId = await seedPinnedParent({});

    // A newer revision of the SAME package arrives without `research`. The
    // parent stays pinned to the old one, so its children keep resolving.
    await seedFlow(ctx, {
      flowRefId: "parent-pkg-next",
      engineMin: "3.7.0",
    });
    await pool.query(
      `UPDATE "flow_revisions" SET "result_profiles" = '{}'::jsonb WHERE "flow_ref_id" = 'parent-pkg-next'`,
    );

    await expect(
      resolveResultContractForDelegation(db, {
        parentRunId,
        name: "research",
      }),
    ).resolves.toMatchObject({ profileName: "research" });
  });

  it("returns null when the spec recorded no profile", async () => {
    const parentRunId = await seedPinnedParent({});

    await expect(
      resolveResultContractForDelegation(db, {
        parentRunId,
        name: undefined,
      }),
    ).resolves.toBeNull();
  });

  it("refuses an unknown name at THIS edge too, naming what the pin does declare", async () => {
    const parentRunId = await seedPinnedParent({});

    await expect(
      resolveResultContractForDelegation(db, {
        parentRunId,
        name: "nope",
      }),
    ).rejects.toMatchObject({
      code: "CONFIG",
      message: expect.stringContaining('"research"'),
    });
  });

  it("refuses below the 3.7.0 floor even when the pin carries a profile map", async () => {
    const parentRunId = await seedPinnedParent({ engineMin: "3.6.0" });

    await expect(
      resolveResultContractForDelegation(db, {
        parentRunId,
        name: "research",
      }),
    ).rejects.toMatchObject({
      code: "CONFIG",
      message: expect.stringContaining("3.7.0"),
    });
  });

  it("refuses when the parent run is not pinned to any revision", async () => {
    const orchestrator = await seedAgent(ctx, { id: "unpinned" });
    const task = await seedTask(ctx);
    const run = await seedOrchestratorRun(ctx, {
      orchestratorAgentId: orchestrator,
      taskId: task.id,
      issueToken: issueOrchestratorRunToken,
    });

    await expect(
      resolveResultContractForDelegation(db, {
        parentRunId: run.runId,
        name: "research",
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});

describe("delegation_spec carries the NAME, never the resolved schema", () => {
  it("an as-plan agent task records only the profile name", async () => {
    const taskId = randomUUID();

    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number", "launch_mode", "delegation_spec")
       VALUES ($1, $2, 42, 't', 'p', 'Backlog', 'Backlog', 1, 'auto', $3::jsonb)`,
      [
        taskId,
        ctx.projectId,
        JSON.stringify({
          kind: "agent",
          agentId: "test-pkg:worker",
          resultProfile: "research",
        }),
      ],
    );

    const row = (
      await pool.query(
        `SELECT "delegation_spec" AS s FROM "tasks" WHERE id = $1`,
        [taskId],
      )
    ).rows[0].s as Record<string, unknown>;

    expect(row.resultProfile).toBe("research");
    // The schema is NOT copied into the spec: a snapshot there would freeze a
    // document the pinned revision may have superseded, and would be a second
    // source of truth for what the child is held to.
    expect(row).not.toHaveProperty("schema");
    expect(row).not.toHaveProperty("sha256");
  });
});
