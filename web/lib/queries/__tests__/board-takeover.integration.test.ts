import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches run-timeline.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getBoardData: typeof import("@/lib/queries/board").getBoardData;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("board_takeover_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ getBoardData } = await import("@/lib/queries/board"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// Seed a real flows + users row and thread the non-null flowId, per the
// project test-hygiene rule (tasks/runs.flow_id is NOT NULL + FK since 0000).
// Unique ids per test — no shared mutable rows.
async function seedHumanWorkingRun(opts: {
  ownerName: string | null;
  ownerEmail: string;
  claimStartedAt: Date;
  branch: string;
}): Promise<{ projectId: string; runId: string; ownerId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Board Takeover Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.users).values({
    id: ownerId,
    name: opts.ownerName,
    email: opts.ownerEmail,
    role: "member",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "takeover task",
    prompt: "p",
    flowId,
    status: "InFlight",
    stage: "Backlog",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "HumanWorking",
    flowVersion: "v1.0.0",
    currentStepId: "review",
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    projectId,
    runId,
    branch: opts.branch,
    worktreePath: `/tmp/${slug}/wt`,
    parentRepoPath: `/tmp/${slug}`,
  });
  // The takeover node_attempts row: owner + the claim time (started_at).
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "review",
    nodeType: "human",
    attempt: 1,
    status: "NeedsInput",
    ownerUserId: ownerId,
    startedAt: opts.claimStartedAt,
  });

  return { projectId, runId, ownerId };
}

describe("getBoardData — HumanWorking takeover surface (integration)", () => {
  it("surfaces owner + claimedAt-derived elapsed + branch on the in-flight card", async () => {
    const claimStartedAt = new Date(Date.now() - 12 * 60 * 1000); // ~12m ago
    const { projectId, runId } = await seedHumanWorkingRun({
      ownerName: "Reviewer Rae",
      ownerEmail: "rae@maister.local",
      claimStartedAt,
      branch: "maister/takeover-1",
    });

    const board = await getBoardData(projectId);

    // The HumanWorking run lands in the in-flight (InProduction) column.
    const flight = board.columns.InProduction.flight;
    const card = flight.find((c) => c.runId === runId);

    expect(card).toBeDefined();
    expect(card?.status).toBe("humanworking");
    // Owner = users.name ?? users.email.
    expect(card?.owner).toBe("Reviewer Rae");
    // Branch surfaced.
    expect(card?.branch).toBe("maister/takeover-1");
    // Elapsed derived from the takeover node_attempts.started_at (not the run
    // startedAt) — ~12 minutes.
    expect(card?.time).toBe("12m");
    // Takeover agent pill = dev.
    expect(card?.agent).toBe("dev");
  });

  it("falls back to owner email when the user name is null", async () => {
    const { projectId, runId } = await seedHumanWorkingRun({
      ownerName: null,
      ownerEmail: "noname@maister.local",
      claimStartedAt: new Date(Date.now() - 60 * 1000),
      branch: "maister/takeover-2",
    });

    const board = await getBoardData(projectId);
    const card = board.columns.InProduction.flight.find(
      (c) => c.runId === runId,
    );

    expect(card?.owner).toBe("noname@maister.local");
  });
});
