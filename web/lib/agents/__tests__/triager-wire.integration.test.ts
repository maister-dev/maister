// Phase 5 / T5.3 (ADR-111): the Triager behavioral wire-through, end-to-end
// against a real Postgres. Two halves:
//   (a) a task.created domain event with the triager's event binding makes the
//       agent_triggers consumer enqueue a triager run_kind='agent' run; an
//       agent-actored event (its own comment) does NOT re-trigger it
//       (self-exclusion);
//   (b) a simulated triager recording a verdict + enqueue:true via the real
//       applyTriageVerdict op stamps the task triaged + launch_mode='auto',
//       which the auto_launch_triaged tick then launches as a flow run.
//
// The launch seams are injected (consumer `launch` for (a) is the REAL
// launchAgentRun resolving the project-pinned triager.md fixture; the tick
// `launch` for (b) is a stub), so no real git/supervisor is needed.
//
// NOTE: a live-agent end-to-end (the triager process actually calling the MCP
// triage ops) is verified manually per project convention; this test fixes the
// wiring contract around the agent, not the agent's own reasoning.

import type { DomainEventRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
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

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { registerPackageAgents } from "@/lib/agents/registry";
import { actorForUserId } from "@/lib/social/activity";

vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let cacheRoot: string;
let worktreesTmp: string;
let originalWorktreesRoot: string | undefined;

let triggers: typeof import("@/lib/agents/triggers");
let applyTriageVerdict: typeof import("@/lib/services/triage").applyTriageVerdict;
let runAutoLaunchTriagedJob: typeof import("@/lib/scheduler/handlers/auto-launch-triaged").runAutoLaunchTriagedJob;

const TRIAGER_MD_PATH = path.join(
  __dirname,
  "fixtures",
  "core-package",
  "maister-agents",
  "triager.md",
);

const AGENT_ID = "core:triager";

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-wire-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  triggers = await import("@/lib/agents/triggers");
  ({ applyTriageVerdict } = await import("@/lib/services/triage"));
  ({ runAutoLaunchTriagedJob } = await import(
    "@/lib/scheduler/handlers/auto-launch-triaged"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  await rm(cacheRoot, { recursive: true, force: true });
});

let projectId: string;
let executorId: string;
let flowId: string;
let installedPath: string;

beforeEach(async () => {
  worktreesTmp = await mkdtemp(path.join(os.homedir(), ".maister-wire-wt-"));
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;

  await pool.query(`DELETE FROM "task_activity"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "task_relations"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "agent_schedules"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "project_package_attachments"`);
  await pool.query(`DELETE FROM "package_installs"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', '/tmp/wire-repo', 'main', 'maister/', '/tmp/maister.yaml', $3, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  await (db as any)
    .insert((await import("@/lib/db/schema")).platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );

  // The core package: real triager.md copied into a fresh install dir, the
  // package_installs row + attachment + (for the real launch path) the matching
  // flow pin, so resolveEffectiveAgentDefinition resolves the triager.
  installedPath = path.join(cacheRoot, `core-${randomUUID().slice(0, 8)}`);
  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(installedPath, "maister-agents", "triager.md"),
    await readFile(TRIAGER_MD_PATH, "utf8"),
    "utf8",
  );

  const packageInstallId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/maisterhq/maister-plugins', 'core', 'v1.0.0', 'rev-core-1',
             '{"spec":{"name":"core","flows":[]},"inventory":{"platformAgents":["triager"]}}'::jsonb,
             'digest', $2, 'Installed', 'trusted')`,
    [packageInstallId, installedPath],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, 'core')`,
    [randomUUID(), projectId, packageInstallId],
  );

  // Register the catalog index row from the real definition (flow-less pkg).
  await registerPackageAgents(packageInstallId, db);

  // A separate launchable flow the triager would route a task to (and the tick
  // launches). Independent of the core package.
  const flowRevisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, 'bugfix', 'github.com/acme/bugfix', 'v1.0.0', 'rev-bugfix-1',
             'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [flowRevisionId, installedPath],
  );
  flowId = randomUUID();
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'bugfix', 'github.com/acme/bugfix', 'v1.0.0', $3,
             '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [flowId, projectId, installedPath, flowRevisionId],
  );
});

afterEach(async () => {
  if (originalWorktreesRoot === undefined) {
    delete process.env.MAISTER_WORKTREES_ROOT;
  } else {
    process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
  }
  await rm(worktreesTmp, { recursive: true, force: true });
});

// Attach + link the triager + seed its recommended event binding.
async function attachAndBindTriager(): Promise<void> {
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id", "enabled") VALUES ($1, $2, $3, true)`,
    [randomUUID(), AGENT_ID, projectId],
  );
  await pool.query(
    `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match", "enabled")
     VALUES ($1, $2, $3, 'event', '{"kinds":["task.created","task.triage_requeued","task.comment_added"]}'::jsonb, true)`,
    [randomUUID(), AGENT_ID, projectId],
  );
}

async function seedTask(): Promise<string> {
  const taskId = randomUUID();
  const number = Math.trunc(Math.random() * 1e9) + 1;

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number")
     VALUES ($1, $2, $3, 'Login is broken', 'fix the login bug', 'Backlog', 'Backlog', 1)`,
    [taskId, projectId, number],
  );

  return taskId;
}

function fakeEvent(overrides: Partial<DomainEventRow>): DomainEventRow {
  return {
    id: 1n as unknown as DomainEventRow["id"],
    kind: "task.created",
    projectId,
    taskId: null,
    runId: null,
    actorType: "user",
    actorId: randomUUID(),
    payload: { title: "t" },
    occurredAt: new Date(),
    createdAt: new Date(),
    txId: "0" as unknown as DomainEventRow["txId"],
    ...overrides,
  } as DomainEventRow;
}

async function agentRunCount(): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1 AND "run_kind" = 'agent'`,
    [AGENT_ID],
  );

  return r.rows[0].n;
}

describe("(a) task.created -> agent_triggers consumer enqueues a triager run", () => {
  it("enqueues exactly one run_kind='agent' run for the triager via the REAL launch path", async () => {
    await attachAndBindTriager();
    const taskId = await seedTask();

    // The real consumer launch path resolves the project-pinned triager.md.
    const consumer = triggers.buildAgentTriggersConsumer({ db });

    await consumer.handle([
      fakeEvent({
        id: 5001 as unknown as DomainEventRow["id"],
        kind: "task.created",
        taskId,
      }),
    ]);

    const rows = await pool.query(
      `SELECT "run_kind", "trigger_source", "trigger_event_id", "task_id" FROM "runs" WHERE "agent_id" = $1`,
      [AGENT_ID],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].run_kind).toBe("agent");
    expect(rows.rows[0].trigger_source).toBe("domain_event");
    expect(Number(rows.rows[0].trigger_event_id)).toBe(5001);
    expect(rows.rows[0].task_id).toBe(taskId);
  });

  it("a self-actored event (the triager's own comment) never re-triggers it", async () => {
    await attachAndBindTriager();
    const taskId = await seedTask();

    const consumer = triggers.buildAgentTriggersConsumer({ db });

    // The triager's OWN comment (the clarifying question it just asked).
    await consumer.handle([
      fakeEvent({
        id: 5002 as unknown as DomainEventRow["id"],
        kind: "task.comment_added",
        taskId,
        actorType: "agent",
        actorId: AGENT_ID,
      }),
    ]);

    expect(await agentRunCount()).toBe(0);

    // The human's reply DOES re-trigger it.
    await consumer.handle([
      fakeEvent({
        id: 5003 as unknown as DomainEventRow["id"],
        kind: "task.comment_added",
        taskId,
        actorType: "user",
        actorId: randomUUID(),
      }),
    ]);

    expect(await agentRunCount()).toBe(1);
  });
});

describe("(b) triager verdict + enqueue -> auto_launch_triaged tick launches a flow run", () => {
  it("applyTriageVerdict(enqueue) stamps triaged+auto and the tick launches the flow run", async () => {
    const taskId = await seedTask();

    // Simulate the triager recording its verdict with enqueue:true (the same op
    // the ext triage route calls), in a transaction as the route does.
    await db.transaction(async (tx) => {
      await applyTriageVerdict(tx, {
        taskId,
        projectId,
        verdict: {
          flowId,
          runnerId: executorId,
          baseBranch: "main",
        },
        actor: actorForUserId(null),
        enqueue: true,
      });
    });

    // The task is now triaged + auto-enqueued.
    const task = (
      await pool.query(
        `SELECT "triage_status", "launch_mode", "flow_id" FROM "tasks" WHERE "id" = $1`,
        [taskId],
      )
    ).rows[0];

    expect(task.triage_status).toBe("triaged");
    expect(task.launch_mode).toBe("auto");
    expect(task.flow_id).toBe(flowId);

    // The tick runs with an injected launch (no real git/supervisor) and picks
    // up the candidate.
    const launches: Array<{ taskId: string | undefined }> = [];
    const summary = await runAutoLaunchTriagedJob({
      db,
      launch: async (input) => {
        launches.push({ taskId: input.taskId });

        return { runId: randomUUID(), status: "Running" };
      },
    });

    expect(summary.launched).toBe(1);
    expect(summary.gaveUp).toBe(0);
    expect(launches).toEqual([{ taskId }]);
  });

  it("a flagged task is NOT launched by the tick (held)", async () => {
    const taskId = await seedTask();

    // The triager flagged the task instead of triaging — set the state the flag
    // op produces (flagged, no enqueue).
    await pool.query(
      `UPDATE "tasks" SET "triage_status" = 'flagged' WHERE "id" = $1`,
      [taskId],
    );

    const launches: string[] = [];
    const summary = await runAutoLaunchTriagedJob({
      db,
      launch: async (input) => {
        launches.push(input.taskId ?? "");

        return { runId: randomUUID(), status: "Running" };
      },
    });

    expect(summary.launched).toBe(0);
    expect(launches).toEqual([]);
  });
});
