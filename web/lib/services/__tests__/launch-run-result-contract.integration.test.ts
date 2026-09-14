import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
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

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { flowYamlV1Schema, type FlowYamlV1 } from "@/lib/config.schema";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;
const execFileAsync = promisify(execFile);

// ADR-165 AC-11 / AC-12, spec C-6. The run's PUBLIC RESULT CONTRACT is written
// by the LAUNCHER, from the pinned revision's install path, BEFORE any worktree
// exists — and it is the snapshot every later reader uses.
//
// The seam and terminal suites SEED `runs.result_contract` directly, which
// presumes this. Two things only a launch can prove live here: that an
// unresolvable schema refuses with ZERO durable rows (resolving it at the seam
// instead would mean the failure arrives after a worktree, a session and token
// spend), and that re-pointing the flow's enabled revision afterwards cannot
// move a run already in flight.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireActiveSession: vi.fn(async () => ({ id: "binding-admin" })),
  requireProjectAction: vi.fn(async () => ({ role: "admin" })),
}));
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
    promoteNextPending: vi.fn(async () => null),
  };
});
vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: vi.fn(async () => ({ kind: "available" as const })),
    listSessions: vi.fn(async () => []),
  };
});

let launchRun: typeof import("@/lib/services/runs").launchRun;

let projectId: string;
let executorId: string;
let flowId: string;
let revisionId: string;
let repoPath: string;
let installPath: string;

const EXT_CTX = {
  actorUserId: null,
  authorize: async () => {},
} as unknown as Parameters<typeof import("@/lib/services/runs").launchRun>[1];

const RESULT_SCHEMA = {
  schemaVersion: 1,
  fields: [
    { name: "summary", type: "string", required: true },
    {
      name: "outcome",
      type: "enum",
      required: true,
      options: ["completed", "blocked"],
    },
  ],
};

const SCHEMA_REL = "./schemas/research-result.v1.json";

/** A one-orchestrator graph that EXPORTS its result. */
function exportingManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "Exporter",
    compat: { engine_min: "3.7.0" },
    result: {
      export: { schema: SCHEMA_REL, from: ["produce"], required: true },
    },
    nodes: [
      {
        id: "produce",
        type: "cli",
        action: { command: "echo hi" },
        output: { result: { schema: SCHEMA_REL, required: true } },
        transitions: { success: "done" },
      },
    ],
  };
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rc-repo-"));

  await execFileAsync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@t"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);

  return dir;
}

/** Writes the schema doc into a revision's install dir, or omits it. */
async function makeInstallDir(withSchema: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rc-flow-"));

  if (withSchema) {
    await mkdir(join(dir, "schemas"), { recursive: true });
    await writeFile(
      join(dir, "schemas", "research-result.v1.json"),
      `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`,
      "utf8",
    );
  }

  return dir;
}

async function seedRevision(args: {
  id: string;
  resolved: string;
  installedPath: string;
  manifest: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "engine_min",
        "installed_path", "package_status", "setup_status")
     VALUES ($1, 'exporter', 'github.com/acme/exporter', 'v1.0.0', $2, 'digest',
             $3::jsonb, 1, '3.7.0', $4, 'Installed', 'done')`,
    [args.id, args.resolved, JSON.stringify(args.manifest), args.installedPath],
  );
}

async function seedTask(): Promise<string> {
  const taskId = randomUUID();

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number", "flow_id", "launch_mode")
     VALUES ($1, $2, $3, 'export me', 'produce a result', 'Backlog', 'Backlog', 1, $4, 'manual')`,
    [taskId, projectId, Math.trunc(Math.random() * 1e9) + 1, flowId],
  );

  return taskId;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "launch_result_contract_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-166: launches gate on a registered local execution host.
  await fakeExecutionHosts(db);
  ({ launchRun } = await import("@/lib/services/runs"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  for (const t of [
    "run_sessions",
    "workspaces",
    "execution_commands",
    "runs",
    "task_relations",
    "tasks",
    "flows",
    "flow_revisions",
    "projects",
  ]) {
    await pool.query(`DELETE FROM "${t}"`);
  }

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
  revisionId = randomUUID();
  repoPath = await initRepo();
  installPath = await makeInstallDir(true);

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      repoPath,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );
  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );

  await seedRevision({
    id: revisionId,
    resolved: "rev-one",
    installedPath: installPath,
    manifest: exportingManifest(),
  });
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'exporter', 'github.com/acme/exporter', 'v1.0.0', $3,
             $4::jsonb, 1, $5, 'Enabled', 'trusted', 'pinned')`,
    [
      flowId,
      projectId,
      installPath,
      JSON.stringify(exportingManifest()),
      revisionId,
    ],
  );
});

describe("launch writes the public result contract (AC-11)", () => {
  it("snapshots the flow_export contract from the PINNED revision", async () => {
    const taskId = await seedTask();
    const { runId } = await launchRun({ taskId, flowId }, EXT_CTX, db);

    const contract = (
      await pool.query(
        `SELECT "result_contract" AS c FROM "runs" WHERE id = $1`,
        [runId],
      )
    ).rows[0].c;

    expect(contract).toMatchObject({
      kind: "flow_export",
      required: true,
      producerNodeIds: ["produce"],
      schemaVersion: 1,
      flowRevisionId: revisionId,
    });
    // The ref names the flow, the resolved revision and the schema stem — the
    // three things needed to say WHICH contract a stored result satisfied.
    expect(contract.schemaRef).toBe("exporter@rev-one:research-result.v1");
    // The digest is over the schema DOCUMENT's bytes, so a schema edited under
    // a stable package ref is detectable from a persisted result after the fact.
    expect(contract.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(contract.schema).toEqual(RESULT_SCHEMA);
  }, 60_000);

  it("a flow with NO result.export leaves the contract null", async () => {
    const plain = exportingManifest();

    delete (plain as { result?: unknown }).result;
    delete (plain.nodes as Record<string, unknown>[])[0].output;
    await pool.query(`UPDATE flow_revisions SET manifest = $1 WHERE id = $2`, [
      JSON.stringify(plain),
      revisionId,
    ]);
    await pool.query(`UPDATE flows SET manifest = $1 WHERE id = $2`, [
      JSON.stringify(plain),
      flowId,
    ]);

    const taskId = await seedTask();
    const { runId } = await launchRun({ taskId, flowId }, EXT_CTX, db);

    expect(
      (
        await pool.query(
          `SELECT "result_contract" AS c FROM "runs" WHERE id = $1`,
          [runId],
        )
      ).rows[0].c,
    ).toBeNull();
  }, 60_000);

  it("an UNRESOLVABLE export schema refuses BEFORE the worktree, leaving no rows", async () => {
    // The revision's install dir has no `schemas/` at all.
    const emptyInstall = await makeInstallDir(false);

    await pool.query(
      `UPDATE flow_revisions SET installed_path = $1 WHERE id = $2`,
      [emptyInstall, revisionId],
    );
    await pool.query(`UPDATE flows SET installed_path = $1 WHERE id = $2`, [
      emptyInstall,
      flowId,
    ]);

    const taskId = await seedTask();
    let code: string | null = null;
    let message = "";

    try {
      await launchRun({ taskId, flowId }, EXT_CTX, db);
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      code = (err as { code: string }).code;
      message = (err as { message: string }).message;
    }

    expect(code, "an unresolvable export schema must refuse").toBe("CONFIG");
    // Pin the REASON, not just the code: `launchRun` throws CONFIG for a dozen
    // unrelated preconditions, so a bare code assertion would stay green if the
    // launch failed for any of them and the contract path never ran at all.
    expect(message).toContain("research-result.v1.json");
    // ZERO durable rows: the refusal lands before the run insert AND before any
    // git side-effect, which is the whole reason it is resolved this early.
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "runs"`)).rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "workspaces"`)).rows[0]
        .n,
    ).toBe(0);
  }, 60_000);
});

describe("the snapshot is immune to revision drift (AC-12)", () => {
  it("re-pointing enabled_revision_id after launch moves neither the contract nor its schema", async () => {
    const taskId = await seedTask();
    const { runId } = await launchRun({ taskId, flowId }, EXT_CTX, db);
    const before = (
      await pool.query(
        `SELECT "result_contract" AS c FROM "runs" WHERE id = $1`,
        [runId],
      )
    ).rows[0].c;

    // A SECOND revision whose schema doc differs, then point the flow at it —
    // exactly what a package upgrade does under a live run.
    const nextInstall = await mkdtemp(join(tmpdir(), "rc-flow2-"));

    await mkdir(join(nextInstall, "schemas"), { recursive: true });
    await writeFile(
      join(nextInstall, "schemas", "research-result.v1.json"),
      `${JSON.stringify({ schemaVersion: 2, fields: [] }, null, 2)}\n`,
      "utf8",
    );

    const nextRevisionId = randomUUID();

    await seedRevision({
      id: nextRevisionId,
      resolved: "rev-two",
      installedPath: nextInstall,
      manifest: exportingManifest(),
    });
    await pool.query(
      `UPDATE flows SET enabled_revision_id = $1, installed_path = $2 WHERE id = $3`,
      [nextRevisionId, nextInstall, flowId],
    );

    const after = (
      await pool.query(
        `SELECT "result_contract" AS c FROM "runs" WHERE id = $1`,
        [runId],
      )
    ).rows[0].c;

    expect(after).toEqual(before);
    expect(after.flowRevisionId).toBe(revisionId);
    expect(after.schemaRef).toBe("exporter@rev-one:research-result.v1");
    // Still schemaVersion 1 — the run validates against what it launched with.
    expect(after.schema.schemaVersion).toBe(1);
  }, 60_000);
});

function consensusManifest(
  participantRunner: string,
  synthesizerRunner: string,
): FlowYamlV1 {
  return flowYamlV1Schema.parse({
    schemaVersion: 1,
    name: "Consensus launch",
    runner_profiles: {
      planner: { capability_agent: "claude", effort: "high" },
      independent: { capability_agent: "codex", effort: "high" },
    },
    nodes: [
      {
        id: "plan_consensus",
        type: "consensus",
        prompt: "Plan the task.",
        participants: [
          { id: "planner-draft", runner: "planner" },
          { id: "independent-draft", runner: participantRunner },
        ],
        synthesizer: { runner: synthesizerRunner },
        workspace: { mode: "repo_read" },
        material_axes: ["correctness"],
        rounds: { mode: "iterate", max: 2 },
        on_no_consensus: "escalate",
        output: {
          produces: [
            { id: "consensus_plan", kind: "plan", current: true },
            { id: "debate_log", kind: "human_note", current: true },
          ],
        },
        transitions: { success: "done" },
      },
    ],
  });
}

async function installConsensusManifest(manifest: FlowYamlV1): Promise<void> {
  await pool.query("UPDATE flow_revisions SET manifest = $1 WHERE id = $2", [
    JSON.stringify(manifest),
    revisionId,
  ]);
  await pool.query("UPDATE flows SET manifest = $1 WHERE id = $2", [
    JSON.stringify(manifest),
    flowId,
  ]);
  for (const model of ["gpt-5.6-terra", "gpt-5.6-sol"]) {
    await pool.query(
      `INSERT INTO platform_acp_runners
        (id, adapter, capability_agent, model, provider, permission_policy,
         readiness_status, readiness_reasons, enabled)
       VALUES ($1, 'codex', 'codex', $2, '{"kind":"openai"}', 'default',
               'Ready', '[]', true)`,
      [randomUUID(), model],
    );
  }
}

async function saveRunnerBinding(
  slotKey: string,
  mappedRunnerId: string,
): Promise<Response> {
  const { PATCH } = await import(
    "@/app/api/projects/[slug]/flow-runner-remaps/route"
  );
  const slug = `p-${projectId.slice(0, 8)}`;

  return PATCH(
    new NextRequest(
      `http://localhost/api/projects/${slug}/flow-runner-remaps`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flowRevisionId: revisionId,
          slotKey,
          mappedRunnerId,
        }),
      },
    ),
    { params: Promise.resolve({ slug }) },
  );
}

describe("consensus runner admission", () => {
  it.each([
    {
      participantRunner: "independent",
      synthesizerRunner: "planner",
      role: "independent-draft",
    },
    {
      participantRunner: "planner",
      synthesizerRunner: "independent",
      role: "synthesizer",
    },
  ])(
    "refuses an ambiguous $role before creating a run or worktree",
    async ({ participantRunner, synthesizerRunner, role }) => {
      await installConsensusManifest(
        consensusManifest(participantRunner, synthesizerRunner),
      );
      const taskId = await seedTask();
      const before = await execFileAsync("git", [
        "-C",
        repoPath,
        "worktree",
        "list",
        "--porcelain",
      ]);

      await expect(
        launchRun({ taskId, flowId }, EXT_CTX, db),
      ).rejects.toMatchObject({
        code: "CONFIG",
        message: expect.stringContaining(`consensus:plan_consensus:${role}`),
      });
      for (const table of ["runs", "workspaces", "run_sessions"]) {
        expect(
          (
            await pool.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM ${table}`,
            )
          ).rows[0].count,
        ).toBe(0);
      }
      const after = await execFileAsync("git", [
        "-C",
        repoPath,
        "worktree",
        "list",
        "--porcelain",
      ]);

      expect(after.stdout).toBe(before.stdout);
      expect(
        (
          await pool.query<{ status: string }>(
            "SELECT status FROM tasks WHERE id = $1",
            [taskId],
          )
        ).rows[0].status,
      ).toBe("Backlog");
    },
    60_000,
  );

  it("admits a blocked consensus after its role is assigned through the project API", async () => {
    await installConsensusManifest(consensusManifest("independent", "planner"));
    const taskId = await seedTask();

    await expect(
      launchRun({ taskId, flowId }, EXT_CTX, db),
    ).rejects.toMatchObject({ code: "CONFIG" });

    const runnerId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM platform_acp_runners WHERE capability_agent = 'codex' ORDER BY id LIMIT 1",
      )
    ).rows[0].id;

    const response = await saveRunnerBinding(
      "consensus:plan_consensus:independent-draft",
      runnerId,
    );

    expect(response.status).toBe(200);
    expect(
      (
        await pool.query<{ mapped_runner_id: string }>(
          "SELECT mapped_runner_id FROM flow_runner_remaps WHERE project_id = $1 AND flow_revision_id = $2 AND slot_key = $3",
          [projectId, revisionId, "consensus:plan_consensus:independent-draft"],
        )
      ).rows,
    ).toEqual([{ mapped_runner_id: runnerId }]);

    const { runId } = await launchRun({ taskId, flowId }, EXT_CTX, db);

    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM runs WHERE id = $1",
          [runId],
        )
      ).rows[0].status,
    ).toBe("Pending");
  }, 60_000);

  it("identifies an unbound ordinary session even when every consensus role is mapped", async () => {
    const consensus = consensusManifest("independent", "planner");
    const sessionNames = [
      "planning",
      "implement",
      "verify",
      "cross",
      "fix",
      "commit",
    ];
    const manifest = flowYamlV1Schema.parse({
      ...consensus,
      sessions: Object.fromEntries(
        sessionNames.map((name) => [
          name,
          { runner: name === "cross" ? "independent" : "planner" },
        ]),
      ),
      nodes: [
        ...sessionNames.map((name, index) => ({
          id: `step_${name}`,
          type: "ai_coding",
          session: name,
          action: { prompt: `Perform ${name}.` },
          transitions: {
            success:
              index + 1 < sessionNames.length
                ? `step_${sessionNames[index + 1]}`
                : "plan_consensus",
          },
        })),
        ...consensus.nodes,
      ],
    });

    await installConsensusManifest(manifest);
    const independentRunnerId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM platform_acp_runners WHERE capability_agent = 'codex' ORDER BY id LIMIT 1",
      )
    ).rows[0].id;

    for (const [slotKey, runnerId] of [
      ["consensus:plan_consensus:planner-draft", executorId],
      ["consensus:plan_consensus:independent-draft", independentRunnerId],
      ["consensus:plan_consensus:synthesizer", executorId],
    ]) {
      expect((await saveRunnerBinding(slotKey, runnerId)).status).toBe(200);
    }
    const taskId = await seedTask();

    await pool.query("UPDATE tasks SET runner_id = $1 WHERE id = $2", [
      executorId,
      taskId,
    ]);
    await expect(
      launchRun({ taskId, flowId }, EXT_CTX, db),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: {
        reason: "flow_runner_unresolved",
        slotKey: "session:cross",
        label: "cross",
      },
    });
    expect((await pool.query("SELECT id FROM runs")).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM workspaces")).rows).toEqual([]);

    expect(
      (await saveRunnerBinding("session:cross", independentRunnerId)).status,
    ).toBe(200);
    const { runId } = await launchRun({ taskId, flowId }, EXT_CTX, db);
    const sessions = await pool.query<{
      session_name: string;
      runner_id: string;
    }>(
      "SELECT session_name, runner_id FROM run_sessions WHERE run_id = $1 ORDER BY session_name",
      [runId],
    );

    expect(sessions.rows).toEqual(
      [...sessionNames].sort().map((name) => ({
        session_name: name,
        runner_id: name === "cross" ? independentRunnerId : executorId,
      })),
    );
  }, 60_000);
});
