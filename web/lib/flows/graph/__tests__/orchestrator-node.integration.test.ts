// M37 (ADR-098) T2.4/T2.5: the orchestrator node's supervisory lifecycle,
// end-to-end through the real graph runner. ONLY the agent action is scripted
// (runAgentStep returns needsInput=true, as a real coordinator would when it
// parks awaiting its delegated children). Asserts:
//   - the run parks on WaitingOnChildren, NOT NeedsInput (a HITL signal);
//   - no run.needs_input webhook fires for the coordinator;
//   - the node_attempt is marked NeedsInput (ledger pause retained);
//   - the run-bound maister-facade token is issued AND survives the park
//     (the model-only materialization on the claude executor triggers issuance).

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";

const schema = fullSchema as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

// Scripted coordinator: its single dispatch yields needsInput=true (parked
// awaiting children) with a session handle, mirroring a real ACP pause.
const agentCalls: Array<{ stepId: string; prompt: string }> = [];

vi.mock("@/lib/flows/runner-agent", () => ({
  runAgentStep: vi.fn(async (step: { id: string; prompt: string }) => {
    agentCalls.push({ stepId: step.id, prompt: step.prompt });

    return {
      ok: true,
      stdout: "",
      vars: {},
      durationMs: 1,
      needsInput: true,
      acpSessionId: "acp-coordinator-1",
    };
  }),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_orchestrator")
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
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

beforeEach(() => {
  agentCalls.splice(0);
});

// A single orchestrator node that transitions to `done` on success. Engine
// floor 1.6.0 — the orchestrator node's version floor (M37, ADR-098).
const orchestratorFlow = {
  schemaVersion: 1,
  name: "Orchestrator",
  compat: { engine_min: "1.6.0" },
  nodes: [
    {
      id: "coordinate",
      type: "orchestrator",
      action: { prompt: "/coordinate the delivery" },
      transitions: { success: "done" },
    },
  ],
};

async function seedOrchestratorRun(): Promise<{
  runId: string;
  projectId: string;
  runtimeRoot: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const projectSlug = `proj-${projectId.slice(0, 8)}`;

  const repo = await mkdtemp(join(tmpdir(), "maister-orc-parent-"));
  const wtRoot = await mkdtemp(join(tmpdir(), "maister-orc-wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "maister-orc-rt-"));

  createdPaths.push(repo, wtRoot, runtimeRoot);

  const worktree = join(wtRoot, runId);
  const branch = `maister/${runId.slice(0, 8)}`;

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.local");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: projectSlug,
    name: "Test",
    repoPath: repo,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "orc",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/orc",
    manifest: orchestratorFlow,
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch,
    worktreePath: worktree,
    parentRepoPath: repo,
    baseBranch: "main",
  });

  return { runId, projectId, runtimeRoot };
}

async function getRun(runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0];
}

describe("orchestrator node — supervisory lifecycle (M37)", () => {
  it("parks on WaitingOnChildren (not NeedsInput), no run.needs_input webhook, token survives", async () => {
    const { runId, runtimeRoot } = await seedOrchestratorRun();

    // Lazy import so the runner-agent / db-client mocks are installed first.
    const { runFlow } = await import("@/lib/flows/runner");

    await runFlow(runId, { db, runtimeRoot });

    // The coordinator was dispatched as an ACP agent step.
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0].stepId).toBe("coordinate");

    // CORE: the run parks on WaitingOnChildren — NOT NeedsInput.
    const run = await getRun(runId);

    expect(run.status).toBe("WaitingOnChildren");
    expect(run.currentStepId).toBe("coordinate");
    // The pause persisted the coordinator's resume handle for Phase-5 wakeup.
    // M42 (ADR-114): the handle lives on the run's default run_sessions row.
    const session = await loadActiveRunSession(db, runId);

    expect(session?.acpSessionId).toBe("acp-coordinator-1");

    // The node_attempt ledger row is paused (NeedsInput), the orchestrator
    // park keeps the ledger mark.
    const attempts = await db
      .select()
      .from(schema.nodeAttempts)
      .where(eq(schema.nodeAttempts.runId, runId));

    const coordinate = attempts.find((a: any) => a.nodeId === "coordinate");

    expect(coordinate?.nodeType).toBe("orchestrator");
    expect(coordinate?.status).toBe("NeedsInput");

    // NO run.needs_input webhook — a coordinator parks on children, not a human.
    const needsInputEvents = await db
      .select()
      .from(schema.webhookEvents)
      .where(
        and(
          eq(schema.webhookEvents.runId, runId),
          eq(schema.webhookEvents.type, "run.needs_input"),
        ),
      );

    expect(needsInputEvents).toHaveLength(0);

    // The run-bound maister-facade token was issued (model-only materialization
    // on the claude executor) and is NOT revoked while parked — the Phase-5
    // resume re-authenticates the respawned coordinator with it.
    const liveTokens = await db
      .select()
      .from(schema.projectTokens)
      .where(
        and(
          eq(schema.projectTokens.name, `orchestrator-run:${runId}`),
          isNull(schema.projectTokens.revoked_at),
        ),
      );

    expect(liveTokens).toHaveLength(1);
    expect(liveTokens[0].token_kind).toBe("project");
    expect(liveTokens[0].agent_id).toBeNull();
  });
});
