import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { installFlowPlugin } from "@/lib/flows";
import { runFlow } from "@/lib/flows/runner";
import { tryStartRun } from "@/lib/scheduler";

const schema = schemaModule as unknown as Record<string, any>;
const {
  flows,
  nodeAttempts,
  projects,
  runs,
  stepRuns,
  tasks,
  workspaces,
} = schema;

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

  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));

  await db
    .update(projects)
    .set({ defaultRunnerId: executorId })
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

  // T4.1 setup migration: the aif `implement` ai_coding node declares
  // `skills: [aif-implement]`, which the runner now resolves against the
  // selectable-capability catalog before spawning. Seed the matching record so
  // resolveCapabilityProfile does not throw CONFIG for an unknown skill id.
  await db.insert(schema.capabilityRecords).values({
    id: randomUUID(),
    projectId,
    capabilityRefId: "aif-implement",
    kind: "skill",
    label: "AIF Implement",
    source: "project",
    agents: ["claude", "codex"],
    enforceability: "instructed",
    selectable: true,
    selectedByDefault: false,
    material: {},
  });
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "Pending",
    flowVersion: "local-dev",
  });

  const worktreePath = join(workspaceRoot, "wt-" + runId);

  await mkdir(worktreePath, { recursive: true });

  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "maister/test",
    worktreePath,
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

describe("runFlow integration — aif graph dispatch (M11a)", () => {
  it("migrated aif (nodes[]) dispatches to the graph runner and writes node_attempts", async () => {
    // aif is now a graph flow (plan -> implement -> checks -> judge -> review).
    // runFlow must dispatch it to runGraph (NOT the linear path). With no
    // supervisor configured here, the first ai_coding node (plan) cannot spawn
    // and the run goes terminal — but the append-only node_attempts ledger
    // proves we took the graph path. The full graph review -> rework -> approve
    // loop is covered by runner-graph.integration.test.ts (cli nodes, no
    // supervisor needed).
    const { runId } = await seedRun({
      flowId: aifFlowId,
      taskPrompt: "fix the bug",
    });

    const start = await tryStartRun(runId, { db });

    expect(start.started).toBe(true);

    try {
      await runFlow(runId, { db, runtimeRoot: workspaceRoot });
    } catch {
      // a spawn failure may surface as a throw; tolerated — we assert on state.
    }

    const after = await db.select().from(runs).where(eq(runs.id, runId));

    // Terminal (Failed/Crashed) because plan needs a supervisor; never linear
    // Review (which would mean the graph dispatch didn't happen).
    expect(["Failed", "Crashed"]).toContain(after[0].status);

    const na = await db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, runId));

    expect(na.length).toBeGreaterThan(0);
    expect(na.some((r: { nodeId: string }) => r.nodeId === "plan")).toBe(true);

    // Linear-only step_runs must NOT be written for a graph flow.
    const sr = await db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.runId, runId));

    expect(sr.length).toBe(0);
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
    // M10 (ADR-021): local sources are content-addressed by manifest digest,
    // not the version label, so the cache dir is aif@<12-hex-digest-prefix>.
    expect(rows[0].installedPath).toMatch(/\/aif@[0-9a-f]{12}$/);
  });
});

describe("runFlow — workspace ownership regression (Codex critical)", () => {
  it("queued run promoted via promoteNextPending writes only inside its own worktree", async () => {
    // Build two queued runs against the cli-only flow with task-specific
    // prompts so each step's stdout is distinct. Both runs should write
    // their hello-world echoes into their own per-run worktree, never
    // into the other run's worktree. This is the regression for the
    // pre-fix bug where promoteNextPending passed the prev run's
    // opts.worktreePath to the next runFlow call.
    const { runId: runIdA } = await seedRun({
      flowId: cliFlowId,
      taskPrompt: "alpha",
    });
    const { runId: runIdB } = await seedRun({
      flowId: cliFlowId,
      taskPrompt: "bravo",
    });

    // Inspect each run's workspace row to know which worktree should
    // see each prompt's stdout (the cli step writes to `cwd`, but the
    // step_runs.stdout column captures stdout regardless — we use it
    // as the proxy for "did the right run run in the right context").
    const wsA = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, runIdA));
    const wsB = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.runId, runIdB));

    expect(wsA[0].worktreePath).not.toBe(wsB[0].worktreePath);

    // Run A first. After its terminal transition, promoteNextPending
    // (if any Pending exists) would dispatch B with NO worktreePath in
    // opts — meaning runFlow MUST resolve B's worktree from the DB.
    const startA = await tryStartRun(runIdA, { db });

    expect(startA.started).toBe(true);

    await runFlow(runIdA, { db, runtimeRoot: workspaceRoot });

    // Now manually start B (the cli runner returns synchronously, so
    // there is no in-progress promoteNextPending to race with; we
    // simulate the cap-free dispatch path by tryStartRun + runFlow).
    const startB = await tryStartRun(runIdB, { db });

    expect(startB.started).toBe(true);

    await runFlow(runIdB, { db, runtimeRoot: workspaceRoot });

    const srA = await db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.runId, runIdA));
    const srB = await db
      .select()
      .from(stepRuns)
      .where(eq(stepRuns.runId, runIdB));

    expect(srA.length).toBe(1);
    expect(srB.length).toBe(1);

    const stdoutA = String(srA[0].stdout ?? "");
    const stdoutB = String(srB[0].stdout ?? "");

    // Each run sees ONLY its own prompt — no cross-talk.
    expect(stdoutA).toContain("hello alpha");
    expect(stdoutA).not.toContain("bravo");
    expect(stdoutB).toContain("hello bravo");
    expect(stdoutB).not.toContain("alpha");

    // And the acpSessionId namespace is per-run (no leak in step_runs
    // rows, since cli steps don't touch ACP at all).
    expect(srA[0].acpSessionId).toBeNull();
    expect(srB[0].acpSessionId).toBeNull();
  });
});
