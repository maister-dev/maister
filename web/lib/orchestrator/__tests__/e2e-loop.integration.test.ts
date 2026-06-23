// M37 (ADR-098) — the FULL orchestrator loop, delegate→park→resume→complete,
// driven through the REAL supervisor-client HTTP wire (lib/supervisor-client.ts).
// Unlike the sibling unit integration tests that mock the supervisor seam
// (orchestrator-park / orchestrator-resume / delegate), this test stands up a
// REAL http.Server (e2e/_seed/test-supervisor.ts) and sets
// MAISTER_SUPERVISOR_URL at it, so the real serializer + the real SSE frame
// parser + the real runner/launch session consumers all execute over HTTP+SSE.
//
// The agent is simulated IN-PROCESS by the test supervisor (no adapter
// subprocess). The ONE substitution vs production: the orchestrator session's
// "agent" would, in production, reach the ext /api/v1/ext/runs/delegate route
// through its MCP facade subprocess; that Next route is NOT served in a vitest,
// so the test injects a delegation HOOK that invokes the SAME service the route
// calls (launchAgentRun with the parent/root linkage looked up from the DB —
// exactly app/api/v1/ext/runs/delegate/route.ts:254-267 after auth). The
// supervisor-client HTTP wire stays REAL either way; the browser e2e
// (orchestrator-loop.spec.ts) exercises the real HTTP ext route since Next IS
// served there.
//
// The loop is multi-step async (runFlow + scheduler + the resume consumer). It
// is driven deterministically: children are seeded Pending (tryStartRun forced
// off, as in the delegate suite) so the orchestrator parks BEFORE any child
// finishes; the test then promotes the children, then dispatches the
// child-terminal domain events through the REAL dispatcher into the REAL
// orchestrator_resume consumer (its resumeFlow injected as the REAL runFlow,
// awaited) so the parked coordinator wakes, resumes via session/resume over the
// real wire, and completes its node to terminal.

import type {
  DelegateHook,
  TestSupervisorHandle,
} from "@/e2e/_seed/test-supervisor";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
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

const schema = fullSchema as unknown as Record<string, any>;
const execFileAsync = promisify(execFile);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// getDb() → the testcontainer for every engine path (runner, launch, scheduler,
// finalize, the resume consumer). tryStartRun is forced OFF so a delegated child
// stays Pending at INSERT (the orchestrator parks before any child runs); the
// test then promotes children explicitly via promoteNextPending.
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

// Lazily imported AFTER the mocks install (so the engine sees the test db).
let startTestSupervisor: typeof import("@/e2e/_seed/test-supervisor").startTestSupervisor;
let launchAgentRun: typeof import("@/lib/agents/launch").launchAgentRun;
let runFlow: typeof import("@/lib/flows/runner").runFlow;
let promoteNextPending: typeof import("@/lib/scheduler").promoteNextPending;
let buildOrchestratorResumeConsumer: typeof import("@/lib/domain-events/orchestrator-resume").buildOrchestratorResumeConsumer;
let dispatchDomainEvents: typeof import("@/lib/domain-events/dispatch").dispatchDomainEvents;

let supervisor: TestSupervisorHandle;
let agentsRoot: string;
const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

// The node-test delegation substitution: invoke launchAgentRun directly with
// the parent/root linkage the ext delegate route would set (looked up from the
// DB by the orchestrator runId). This is what makes the orchestrator's "agent
// turn" spawn children WITHOUT a served Next route.
const directLaunchHook: DelegateHook = async (req) => {
  const parentRows = await db
    .select({
      id: schema.runs.id,
      projectId: schema.runs.projectId,
      rootRunId: schema.runs.rootRunId,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, req.orchestratorRunId));
  const parent = parentRows[0];

  if (!parent)
    throw new Error(`orchestrator parent ${req.orchestratorRunId} not found`);

  await launchAgentRun({
    agentId: process.env.MAISTER_TEST_CHILD_AGENT_ID as string,
    projectId: parent.projectId,
    taskId: null,
    launchOverrideRunnerId: null,
    parentRunId: parent.id,
    rootRunId: parent.rootRunId ?? parent.id,
    launchMode: "manual",
    persistent: false,
    addressableKey: null,
    workspaceMode: null,
    trigger: { source: "manual" },
    db,
  });
};

beforeAll(async () => {
  agentsRoot = await mkdtemp(join(tmpdir(), "maister-orc-loop-agents-"));
  createdPaths.push(agentsRoot);

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test_orc_loop")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ startTestSupervisor } = await import("@/e2e/_seed/test-supervisor"));
  ({ launchAgentRun } = await import("@/lib/agents/launch"));
  ({ runFlow } = await import("@/lib/flows/runner"));
  ({ promoteNextPending } = await import("@/lib/scheduler"));
  ({ buildOrchestratorResumeConsumer } = await import(
    "@/lib/domain-events/orchestrator-resume"
  ));
  ({ dispatchDomainEvents } = await import("@/lib/domain-events/dispatch"));

  supervisor = await startTestSupervisor({
    pool,
    childCount: 2,
    delegate: directLaunchHook,
  });
  // The REAL supervisor-client reads MAISTER_SUPERVISOR_URL on every call
  // (lib/supervisor-client.ts baseUrl()) — point it at the test server.
  process.env.MAISTER_SUPERVISOR_URL = supervisor.url;
}, 180_000);

afterAll(async () => {
  await supervisor?.stop();
  await pool?.end();
  await container?.stop();
  delete process.env.MAISTER_SUPERVISOR_URL;
  delete process.env.MAISTER_TEST_CHILD_AGENT_ID;
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
}, 60_000);

let projectId: string;
let executorId: string;
let flowId: string;
let childAgentId: string;

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

beforeEach(async () => {
  await pool.query(`DELETE FROM "domain_events"`);
  await pool.query(`DELETE FROM "domain_event_consumers"`);
  await pool.query(`DELETE FROM "project_tokens"`);
  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "task_relations"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "platform_runtime_settings"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
});

afterEach(() => {
  vi.clearAllMocks();
});

// A child catalog agent with workspace=none → finalizeAgentRun lands the child
// in Done (no workspaces row) and emits the run.done domain event with
// parent_run_id set. (A worktree child would land in Review and emit no
// run.done, so it could never wake the parent.) Mirrors delegate.integration's
// seedAgent.
async function seedChildAgent(): Promise<string> {
  const id = "worker";
  const qualifiedId = `orc-pkg:${id}`;

  const revisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, 'orc-pkg', 'github.com/acme/orc-pkg', 'v1.0.0', 'rev-1',
             'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [revisionId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'orc-pkg', 'github.com/acme/orc-pkg', 'v1.0.0', $3,
             '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), projectId, agentsRoot, revisionId],
  );

  await mkdir(join(agentsRoot, "maister-agents"), { recursive: true });
  await writeFile(
    join(agentsRoot, "maister-agents", `${id}.md`),
    `---
name: ${id}
description: a delegated worker
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
Do the delegated sub-task.
`,
    "utf8",
  );

  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'orc-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $3, true)`,
    [qualifiedId, id, join(agentsRoot, "maister-agents", `${id}.md`)],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

// The orchestrator flow run, seeded directly as Running with a REAL git
// worktree (the proven M37 orchestrator-integration-test pattern —
// orchestrator-park.integration.test.ts — bypasses the launchRun precondition
// gauntlet, which is covered by other suites; the orchestration LOOP is what
// this test drives, through the real supervisor wire).
async function seedOrchestratorRun(): Promise<{ runId: string }> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const projectSlug = `proj-${projectId.slice(0, 8)}`;

  const repo = await mkdtemp(join(tmpdir(), "maister-orc-loop-repo-"));
  const wtRoot = await mkdtemp(join(tmpdir(), "maister-orc-loop-wt-"));

  createdPaths.push(repo, wtRoot);

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
    nextTaskNumber: 1,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );
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
    title: "orchestrate",
    prompt: "coordinate",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
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

  return { runId };
}

async function statusOf(runId: string): Promise<string> {
  const rows = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return rows[0]?.status;
}

async function childRunIds(parentRunId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(eq(schema.runs.parentRunId, parentRunId));

  return rows.map((r) => r.id);
}

async function poll(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`poll timed out after ${timeoutMs}ms waiting for: ${label}`);
}

describe("M37 orchestrator full loop through the real supervisor-client wire", () => {
  it("delegate → park (WaitingOnChildren) → children Done → resume → terminal Review", async () => {
    // Project first (the child agent's package flow FKs the project), then the
    // child catalog agent attached to it.
    const { runId } = await seedOrchestratorRun();

    childAgentId = await seedChildAgent();
    process.env.MAISTER_TEST_CHILD_AGENT_ID = childAgentId;

    // ---- Stage 1: run the orchestrator node through the REAL wire. ----------
    // runFlow → runGraph → real runner-agent → createSession + sendPrompt over
    // HTTP to the test supervisor. On sendPrompt the supervisor reads the facade
    // token from the createSession mcpServers and (via directLaunchHook) spawns
    // 2 children, then emits session.exited{0}. The clean end_turn + 2 pending
    // children → the orchestrator parks on WaitingOnChildren.
    await runFlow(runId, { db, runtimeRoot: process.cwd() });

    expect(await statusOf(runId)).toBe("WaitingOnChildren");

    // createSession was called for the orchestrator EXACTLY ONCE (turn 0, no
    // resume). At this Stage-1 checkpoint the resume create (Stage 3) does not
    // exist yet, so a second create here would be a leaked/double session spawn
    // for the same coordinator turn — fail on it deterministically.
    const orchestratorCreates = supervisor
      .createdSessions()
      .filter((s) => s.runId === runId);

    expect(orchestratorCreates).toHaveLength(1);
    expect(orchestratorCreates[0].isResume).toBe(false);
    // The maister facade token rode the createSession mcpServers payload.
    const facade = orchestratorCreates[0].mcpServers.find(
      (s) => s.name === "maister",
    ) as { env?: Record<string, string> } | undefined;

    expect(facade?.env?.MAISTER_PROJECT_TOKEN).toBeTruthy();

    // Two child agent runs exist with the parent + root linkage, still Pending
    // (tryStartRun forced off), and the orchestrator released its slot at park.
    const children = await childRunIds(runId);

    expect(children).toHaveLength(2);
    const childRows = await pool.query(
      `SELECT "status", "run_kind", "parent_run_id", "root_run_id", "delegation_snapshot"
       FROM "runs" WHERE "parent_run_id" = $1`,
      [runId],
    );

    expect(childRows.rows).toHaveLength(2);
    for (const row of childRows.rows) {
      expect(row.run_kind).toBe("agent");
      expect(row.parent_run_id).toBe(runId);
      expect(row.root_run_id).toBe(runId);
      expect(row.status).toBe("Pending");
      expect(row.delegation_snapshot.agentDefinitionId).toBe(childAgentId);
    }

    // The parked coordinator retains its resume handle.
    const parkedRow = await pool.query(
      `SELECT "acp_session_id", "current_step_id" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(parkedRow.rows[0].acp_session_id).toBeTruthy();
    expect(parkedRow.rows[0].current_step_id).toBe("coordinate");

    // ---- Stage 2: promote the children → they run through the REAL wire. -----
    // promoteNextPending({pool:"agent"}) flips a Pending child to Running and
    // dispatches the default startAgentSession (real HTTP, no injected api) →
    // the test supervisor emits session.exited{0} → consumeAgentSession
    // finalizes the workspace-none child to Done → run.done domain event with
    // parent_run_id set.
    for (let i = 0; i < 2; i += 1) {
      const r = await promoteNextPending({ db, pool: "agent" });

      expect(r.promotedRunId).toBeTruthy();
    }

    await poll(async () => {
      const rows = await pool.query(
        `SELECT count(*)::int AS n FROM "runs" WHERE "parent_run_id" = $1 AND "status" = 'Done'`,
        [runId],
      );

      return rows.rows[0].n === 2;
    }, "both children reach Done");

    // Both children emitted a run.done domain event carrying the parent linkage.
    const doneEvents = await pool.query(
      `SELECT "payload" FROM "domain_events" WHERE "kind" = 'run.done'`,
    );

    expect(doneEvents.rows.length).toBe(2);
    for (const ev of doneEvents.rows) {
      expect(ev.payload.parentRunId).toBe(runId);
    }

    // The orchestrator is still parked — the child terminals have not yet been
    // dispatched to the resume consumer.
    expect(await statusOf(runId)).toBe("WaitingOnChildren");

    // ---- Stage 3: dispatch the child-terminal events through the REAL --------
    // dispatcher into the REAL orchestrator_resume consumer. The consumer's
    // resumeFlow is the REAL runFlow (awaited inline), so winning the
    // WaitingOnChildren→Running CAS re-enters the parked node and resumes the
    // coordinator via session/resume over the real wire. With 0 pending children
    // the node completes → the flow reaches terminal Review.
    //
    // orchestrator_resume is startFrom:"now": pre-seed its cursor at 0 so the
    // already-emitted run.done events are inside its window.
    await pool.query(
      `INSERT INTO "domain_event_consumers" ("consumer_id", "cursor_event_id")
       VALUES ('orchestrator_resume', 0)
       ON CONFLICT ("consumer_id") DO UPDATE SET "cursor_event_id" = 0`,
    );

    const resumeConsumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (resumeRunId, opts) => {
        await runFlow(resumeRunId, opts);
      },
    });

    await dispatchDomainEvents({ db, consumers: [resumeConsumer] });

    // The coordinator woke, resumed over the real wire, completed its node, and
    // the flow reached terminal Review. The resume createSession carried the
    // retained acp_session_id (a resume turn).
    await poll(
      async () => (await statusOf(runId)) === "Review",
      "orchestrator resumes and reaches terminal Review",
    );

    const resumeCreates = supervisor
      .createdSessions()
      .filter((s) => s.runId === runId && s.isResume);

    expect(resumeCreates.length).toBeGreaterThanOrEqual(1);

    // ---- Final assertions: the FULL loop end-to-end. ------------------------
    expect(await statusOf(runId)).toBe("Review");
    const finalChildRows = await pool.query(
      `SELECT "status" FROM "runs" WHERE "parent_run_id" = $1`,
      [runId],
    );

    expect(finalChildRows.rows).toHaveLength(2);
    expect(finalChildRows.rows.every((r) => r.status === "Done")).toBe(true);

    // Run-tree intact: 1 orchestrator + 2 children, all rooted at the orchestrator.
    const tree = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "id" = $1 OR "parent_run_id" = $1`,
      [runId],
    );

    expect(tree.rows[0].n).toBe(3);

    // No stuck slot: the orchestrator is terminal, no run is left Running/Pending.
    const liveRows = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "status" IN ('Running','Pending','WaitingOnChildren')`,
    );

    expect(liveRows.rows[0].n).toBe(0);

    // The orchestrator's current_step_id cleared on terminal completion.
    const finalOrch = await pool.query(
      `SELECT "current_step_id" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(finalOrch.rows[0].current_step_id).toBeNull();
  }, 90_000);
});
