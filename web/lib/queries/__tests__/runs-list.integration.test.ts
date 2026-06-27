// M42 (ADR-114) regression guard for the /runs list reader. The runner mirror
// columns (capability_agent, runner_snapshot, …) were dropped from `runs` and
// moved to `run_sessions`. `listRunsPage` is raw SQL, so a mocked-DB unit test
// can't catch a stale `r.capability_agent` reference — it only fails against the
// real post-drop schema. This runs the query against a migrated Postgres and
// asserts the runner fields resolve from the active run_session.
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { listRunsPage, type RunsListFilters } from "@/lib/queries/runs-list";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const admin = { id: randomUUID(), role: "admin" as const };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("runs_list_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

function filters(overrides: Partial<RunsListFilters> = {}): RunsListFilters {
  return { page: 1, ...overrides };
}

async function seedRunWithSession(agent: "claude" | "codex"): Promise<string> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: `/repos/${slug}`,
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
  });

  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "scratch",
    status: "Running",
    flowVersion: "scratch",
    flowRevision: "manual",
    startedAt: new Date(),
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: null,
    capabilityAgent: agent,
    runnerSnapshot: testRunnerSnapshot(runId, agent),
  });

  return runId;
}

describe("listRunsPage (integration, post-M42 schema)", () => {
  it("projects the runner label from the active run_session, not dropped runs columns", async () => {
    const runId = await seedRunWithSession("claude");

    const page = await listRunsPage({ filters: filters(), user: admin });
    const row = page.rows.find((r) => r.runId === runId);

    expect(row).toBeDefined();
    expect(row?.runnerLabel).toBe("claude · claude-sonnet-4-6");
  });

  it("filters by agent via the active run_session", async () => {
    const claudeRun = await seedRunWithSession("claude");
    const codexRun = await seedRunWithSession("codex");

    const page = await listRunsPage({
      filters: filters({ agent: "claude" }),
      user: admin,
    });
    const ids = page.rows.map((r) => r.runId);

    expect(ids).toContain(claudeRun);
    expect(ids).not.toContain(codexRun);
  });
});
