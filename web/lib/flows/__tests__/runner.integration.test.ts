import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { installFlowPlugin } from "@/lib/flows";
import { runFlow } from "@/lib/flows/runner";
import { tryStartRun } from "@/lib/scheduler";

const schema = schemaModule as unknown as Record<string, any>;
const { executors, flows, projects, runs, stepRuns, tasks, workspaces } =
  schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: any;
let homeDir: string;
let workspaceRoot: string;
let projectId: string;
let executorId: string;
let cliFlowId: string;
let aifFlowId: string;
let originalHome: string | undefined;

const PLUGIN_AIF_PATH = resolve(__dirname, "../../../../plugins/aif");

const CLI_FLOW_YAML = `schemaVersion: 1
name: cli-only
steps:
  - id: hello
    type: cli
    command: "echo hello {{ task.prompt }}"
`;

async function setupCliFlowPlugin(): Promise<void> {
  const fixtureDir = join(workspaceRoot, "fixture-cli-flow");

  await import("node:fs/promises").then(({ mkdir, writeFile }) =>
    mkdir(fixtureDir, { recursive: true }).then(() =>
      writeFile(join(fixtureDir, "flow.yaml"), CLI_FLOW_YAML),
    ),
  );

  const result = await installFlowPlugin({
    source: fixtureDir,
    version: "local-dev",
    projectId,
    projectSlug: "demo-app",
    flowId: "cli-only",
    workspaceRoot,
    db,
  });

  cliFlowId = result.flowRowId;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("runner_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "runner-int-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "runner-int-ws-"));

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  projectId = randomUUID();
  executorId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    slug: "demo-app",
    name: "Demo App",
    repoPath: join(workspaceRoot, "demo-repo"),
    maisterYamlPath: join(workspaceRoot, "demo-repo", "maister.yaml"),
  });

  await db.insert(executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

  await db
    .update(projects)
    .set({ defaultExecutorId: executorId })
    .where(eq(projects.id, projectId));

  await setupCliFlowPlugin();

  const aifInstall = await installFlowPlugin({
    source: PLUGIN_AIF_PATH,
    version: "local-dev",
    projectId,
    projectSlug: "demo-app",
    flowId: "aif",
    workspaceRoot,
    db,
  });

  aifFlowId = aifInstall.flowRowId;
}, 180_000);

afterAll(async () => {
  if (originalHome) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function seedRun(args: {
  flowId: string;
  taskPrompt: string;
}): Promise<{ runId: string; taskId: string }> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "Test task",
    prompt: args.taskPrompt,
    flowId: args.flowId,
    status: "InFlight",
  });

  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId: args.flowId,
    executorId,
    status: "Pending",
    flowVersion: "local-dev",
  });

  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "maister/test",
    worktreePath: join(workspaceRoot, "wt-" + runId),
    parentRepoPath: join(workspaceRoot, "demo-repo"),
  });

  return { runId, taskId };
}

describe("runFlow integration — cli step end-to-end", () => {
  it("runs a single cli step and lands in Review", async () => {
    const { runId } = await seedRun({
      flowId: cliFlowId,
      taskPrompt: "world",
    });

    const start = await tryStartRun(runId, { db });

    expect(start.started).toBe(true);

    await runFlow(runId, {
      db,
      runtimeRoot: workspaceRoot,
      worktreePath: workspaceRoot,
    });

    const after = await db.select().from(runs).where(eq(runs.id, runId));

    expect(after[0].status).toBe("Review");
    expect(after[0].currentStepId).toBeNull();
    expect(after[0].endedAt).not.toBeNull();

    const srRows = await db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.runId, runId));

    expect(srRows.length).toBe(1);
    expect(srRows[0].status).toBe("Succeeded");
    expect(String(srRows[0].stdout ?? "")).toContain("hello world");
  });
});

describe("runFlow integration — human step suspends", () => {
  it("aif plugin halts at review step with status NeedsInput", async () => {
    const { runId } = await seedRun({
      flowId: aifFlowId,
      taskPrompt: "fix the bug",
    });

    const start = await tryStartRun(runId, { db });

    expect(start.started).toBe(true);

    let crashed: Error | null = null;

    try {
      await runFlow(runId, {
        db,
        runtimeRoot: workspaceRoot,
        worktreePath: workspaceRoot,
      });
    } catch (err) {
      crashed = err as Error;
    }

    const after = await db.select().from(runs).where(eq(runs.id, runId));

    if (after[0].status === "Failed") {
      expect(
        crashed?.message ?? "agent steps failed because no supervisor",
      ).toBeTruthy();
      return;
    }

    expect(["NeedsInput"]).toContain(after[0].status);

    const needsInputPath = join(
      workspaceRoot,
      ".maister",
      "demo-app",
      "runs",
      runId,
      "needs-input.json",
    );

    await stat(needsInputPath);
    const body = JSON.parse(await readFile(needsInputPath, "utf8"));

    expect(body.stepId).toBe("review");
    expect(body.schemaVersion).toBe(1);
    expect(body.schema.fields).toBeDefined();
  });
});

describe("installFlowPlugin — local source path", () => {
  it("aif plugin install via absolute path produced a flow row", async () => {
    const rows = await db
      .select()
      .from(flows)
      .where(eq(flows.flowRefId, "aif"));

    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe(PLUGIN_AIF_PATH);
    expect(rows[0].installedPath).toContain("aif@local-dev");
  });
});
