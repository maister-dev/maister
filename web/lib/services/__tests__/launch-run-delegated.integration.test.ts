import type { LaunchRunContext, LaunchRunInput } from "@/lib/services/runs";
import type { FlowDelegationSnapshotInput } from "@/lib/flows/delegatable-flow";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
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

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { minimalGraphManifest } from "@/test-support/delegation-seed";
import {
  seedAcceptedRepositoryQualification,
  isolateEngineFixtureRuntime,
} from "@/test-support/repository-qualification";
import {
  launchQualifiedEngineRun,
  bindAcceptedEngineFixture,
} from "@/test-support/launch-engine-response";
import { createDelegatedTaskLaunchSource } from "@/lib/orchestrator/delegated-launch-authority";
import {
  delegationLaunchOperation,
  delegationPlanRevision,
} from "@/lib/orchestrator/launch-operation";
import { issueOrchestratorRunToken } from "@/lib/agents/tokens";
import { tokenTaskLaunchPrincipal } from "@/lib/tasks/launch-token";
import { establishExecutionChildAdmission } from "@/lib/tasks/qualification-admission";
import {
  serverTaskLaunchRequest,
  acceptServerTaskLaunch,
} from "@/lib/tasks/launch-intent";
import { tasks } from "@/lib/db/schema";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

// ADR-163 REQ-06/REQ-08: a delegated flow child launches through the CANONICAL
// pipeline and persists every launch-time decision a terminal or recovery path
// reads. The point of the snapshot is drift immunity — the project's enabled
// revision can move under a live child, and the child must not move with it.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
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

let restoreEngineRuntime: (() => Promise<void>) | undefined;
let loadRun: typeof import("@/lib/flows/graph/runner-core").loadRun;

beforeAll(async () => {
  restoreEngineRuntime = await isolateEngineFixtureRuntime();
  testDatabase = await startMainPostgresTestDb({
    databaseName: "launch_delegated_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-166: every launch places the run on the local execution host.
  await fakeExecutionHosts(db);

  ({ loadRun } = await import("@/lib/flows/graph/runner-core"));
}, 180_000);

afterAll(async () => {
  await restoreEngineRuntime?.();
  await testDatabase?.stop();
});

let projectId: string;
let executorId: string;
let flowId: string;
let revisionId: string;
let repoPath: string;

const EXT_CTX = {
  actorUserId: null,
  authorize: async () => {},
} as unknown as Parameters<typeof import("@/lib/services/runs").launchRun>[1];

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE runs, task_launch_intents, tasks, flows, flow_revisions, projects CASCADE`,
  );

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
  revisionId = randomUUID();
  repoPath = await initRepo();

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

  await seedRevision(revisionId, "rev-one");
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'delegated', 'github.com/acme/delegated', 'v1.0.0', $5,
             $3::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [
      flowId,
      projectId,
      JSON.stringify(minimalGraphManifest("delegated")),
      revisionId,
      join(repoPath, ".fixture-flow"),
    ],
  );
});

const execFileAsync = promisify(execFile);

/**
 * A real git repo with a `main` branch and one commit — `launchRunStaged`
 * validates both resolved refs against the project's actual branch set before
 * any git side-effect, so a bare tmpdir is refused long before the run insert.
 */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deleg-repo-"));

  await execFileAsync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@t"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);

  await mkdir(join(dir, ".fixture-flow"));

  return realpath(dir);
}

async function seedRevision(id: string, resolved: string): Promise<void> {
  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path",
        "package_status", "setup_status")
     VALUES ($1, 'delegated', 'github.com/acme/delegated', 'v1.0.0', $2, 'digest',
             $3::jsonb, 1, $4, 'Installed', 'done')`,
    [
      id,
      resolved,
      JSON.stringify(minimalGraphManifest("delegated")),
      join(repoPath, ".fixture-flow"),
    ],
  );
}

async function seedCarrierTask(): Promise<string> {
  const taskId = randomUUID();

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number", "flow_id", "launch_mode")
     VALUES ($1, $2, $3, 'carrier', 'do the governed thing', 'Backlog', 'Backlog', 1, $4, 'manual')`,
    [taskId, projectId, Math.trunc(Math.random() * 1e9) + 1, flowId],
  );

  return taskId;
}

async function seedParentRun(): Promise<string> {
  const parentRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision")
     VALUES ($1, 'flow', $2, 'WaitingOnChildren', 'v1', 'rev')`,
    [parentRunId, projectId],
  );

  return parentRunId;
}

// What a child-creation edge may supply: the launcher owns the branch pair AND
// the revision fields (ADR-163 D7 + Codex review F4).
function flowSnapshot(carrierTaskId: string): FlowDelegationSnapshotInput {
  return {
    kind: "flow",
    flowId,
    flowRefId: "delegated",
    carrierTaskId,
    mode: "task",
    runnerOverride: null,
  };
}

async function launchRun(
  input: LaunchRunInput,
  context: LaunchRunContext,
  _connection: NodePgDatabase<typeof schemaModule>,
): Promise<{ runId: string; status: string }> {
  if (!input.parentRunId)
    return launchQualifiedEngineRun(input, context, testDatabase.db);
  await context.authorize(projectId, "launchRun");
  const [task] = await testDatabase.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.taskId));
  const body = {
    target: { flowId: input.flowId! },
    mode: "task" as const,
    title: task.title,
    prompt: task.prompt,
  };
  const token = await issueOrchestratorRunToken({
    projectId,
    runId: input.parentRunId,
    db: testDatabase.db,
  });
  const principal = await tokenTaskLaunchPrincipal(
    testDatabase.db,
    token.secret,
  );
  const operationKey = randomUUID();
  const operation = delegationLaunchOperation(
    "delegate",
    token.tokenId,
    input.parentRunId,
    operationKey,
    body,
  );

  await db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        launchMode: "manual",
        delegationSpec: { kind: "flow", flowId: input.flowId! },
      })
      .where(eq(tasks.id, task.id));
    await establishExecutionChildAdmission(tx, {
      projectId,
      parentRunId: input.parentRunId!,
      childTaskId: task.id,
      planRevision: delegationPlanRevision(operation),
    });
  });
  const source = await createDelegatedTaskLaunchSource(
    testDatabase.db,
    principal,
    projectId,
    task.id,
    body,
    operationKey,
  );
  const receipt = await acceptServerTaskLaunch(
    testDatabase.db,
    source,
    await serverTaskLaunchRequest(testDatabase.db, source, {
      taskId: task.id,
      flowId: input.flowId!,
    }),
    operationKey,
  );

  return bindAcceptedEngineFixture(testDatabase.db, receipt);
}

describe("launchRun with delegation provenance (ADR-163 REQ-06/REQ-08)", () => {
  it("persists the run-tree linkage, the pinned revision, and the full flow snapshot", async () => {
    const parentRunId = await seedParentRun();
    const carrierTaskId = await seedCarrierTask();

    const { runId } = await launchRun(
      {
        taskId: carrierTaskId,
        flowId,
        parentRunId,
        rootRunId: parentRunId,
        launchMode: "manual",
        delegationSnapshot: flowSnapshot(carrierTaskId),
      },
      EXT_CTX,
      db,
    );

    const run = (
      await pool.query(
        `SELECT "run_kind", "task_id", "flow_id", "flow_revision_id", "flow_version",
                "flow_revision", "parent_run_id", "root_run_id", "launch_mode",
                "delegation_snapshot"
           FROM "runs" WHERE "id" = $1`,
        [runId],
      )
    ).rows[0];

    expect(run.run_kind).toBe("flow");
    expect(run.task_id).toBe(carrierTaskId);
    expect(run.flow_id).toBe(flowId);
    expect(run.flow_revision_id).toBe(revisionId);
    expect(run.flow_version).toBe("v1.0.0");
    expect(run.flow_revision).toBe("rev-one");
    expect(run.parent_run_id).toBe(parentRunId);
    expect(run.root_run_id).toBe(parentRunId);
    expect(run.launch_mode).toBe("manual");
    // The launcher completes the caller's snapshot with exactly the fields it
    // resolved itself: the branch pair (D7) and the revision (Codex review F4).
    expect(run.delegation_snapshot).toEqual({
      ...flowSnapshot(carrierTaskId),
      flowRevisionId: revisionId,
      resolvedRevision: "rev-one",
      engineMin: null,
      engineMax: null,
      baseBranch: "main",
      targetBranch: "main",
    });

    // The runner identity lives on run_sessions, never duplicated onto the
    // snapshot (skill-context rule 207).
    const session = (
      await pool.query(
        `SELECT "runner_snapshot", "runner_id" FROM "run_sessions" WHERE "run_id" = $1`,
        [runId],
      )
    ).rows[0];

    expect(session.runner_snapshot).toBeTruthy();
    expect(session.runner_id).toBe(executorId);
  }, 60_000);

  it("D7: base and target branch both resolve to the project's main branch, not the parent's branch", async () => {
    const parentRunId = await seedParentRun();
    const carrierTaskId = await seedCarrierTask();

    const { runId } = await launchRun(
      {
        taskId: carrierTaskId,
        flowId,
        parentRunId,
        rootRunId: parentRunId,
        launchMode: "manual",
        delegationSnapshot: flowSnapshot(carrierTaskId),
      },
      EXT_CTX,
      db,
    );

    const workspace = (
      await pool.query(
        `SELECT "base_branch", "target_branch" FROM "workspaces" WHERE "run_id" = $1`,
        [runId],
      )
    ).rows[0];

    expect(workspace.base_branch).toBe("main");
    expect(workspace.target_branch).toBe("main");
  }, 60_000);

  it("the child is immune to the project's enabled revision moving under it", async () => {
    const parentRunId = await seedParentRun();
    const carrierTaskId = await seedCarrierTask();

    const { runId } = await launchRun(
      {
        taskId: carrierTaskId,
        flowId,
        parentRunId,
        rootRunId: parentRunId,
        launchMode: "manual",
        delegationSnapshot: flowSnapshot(carrierTaskId),
      },
      EXT_CTX,
      db,
    );

    // Advance the LIVE projection: a newer revision becomes the project's
    // enabled one while the child is still running.
    const newerRevisionId = randomUUID();

    await seedRevision(newerRevisionId, "rev-two");
    await pool.query(
      `UPDATE "flows" SET "enabled_revision_id" = $2 WHERE "id" = $1`,
      [flowId, newerRevisionId],
    );

    const run = (
      await pool.query(
        `SELECT "flow_revision_id", "delegation_snapshot" FROM "runs" WHERE "id" = $1`,
        [runId],
      )
    ).rows[0];

    expect(run.flow_revision_id).toBe(revisionId);
    expect(
      (run.delegation_snapshot as { flowRevisionId: string }).flowRevisionId,
    ).toBe(revisionId);

    // And the runner still resolves the manifest from the PINNED revision —
    // `loadRun` reads `runs.flow_revision_id`, not the flow's live pointer.
    const loaded = await loadRun(db as never, runId);

    expect(loaded.run.flowRevisionId).toBe(revisionId);
    expect(loaded.manifest.name).toBe("delegated");
  }, 60_000);

  // Codex review F4: the route resolves the flow once (and built the snapshot
  // from that), the launcher resolves it AGAIN for `runs.flow_revision_id`, and
  // the two resolutions are separated by a committed carrier transaction plus
  // the launcher's own preamble. A repoint of `flows.enabled_revision_id` in
  // that window made the run execute revision B while its "immutable" snapshot
  // claimed revision A. The launcher now owns the snapshot's revision fields
  // exactly as it already owns the branch pair.
  it("the snapshot's revision fields are the launcher's, not the caller's: an enablement repoint inside the launch window cannot make them diverge", async () => {
    const parentRunId = await seedParentRun();
    const carrierTaskId = await seedCarrierTask();
    const newerRevisionId = randomUUID();

    await seedRevision(newerRevisionId, "rev-two");

    // The launcher's `authorize` hook runs after the caller resolved (the
    // snapshot below still names the OLD revision) and before the launcher
    // reads the `flows` row — the real window.
    const repointDuringPreamble = {
      actorUserId: null,
      authorize: async () => {
        await pool.query(
          `UPDATE "flows" SET "enabled_revision_id" = $2 WHERE "id" = $1`,
          [flowId, newerRevisionId],
        );
      },
    } as unknown as Parameters<typeof launchRun>[1];

    const { runId } = await launchRun(
      {
        taskId: carrierTaskId,
        flowId,
        parentRunId,
        rootRunId: parentRunId,
        launchMode: "manual",
        delegationSnapshot: flowSnapshot(carrierTaskId),
      },
      repointDuringPreamble,
      db,
    );

    const run = (
      await pool.query(
        `SELECT "flow_revision_id", "flow_revision", "delegation_snapshot" FROM "runs" WHERE "id" = $1`,
        [runId],
      )
    ).rows[0];
    const snapshot = run.delegation_snapshot as {
      flowRevisionId: string;
      resolvedRevision: string;
    };

    expect(run.flow_revision_id).toBe(newerRevisionId);
    expect(snapshot.flowRevisionId).toBe(run.flow_revision_id);
    expect(snapshot.resolvedRevision).toBe(run.flow_revision);
    expect(snapshot.resolvedRevision).toBe("rev-two");
  }, 60_000);

  it("a NON-delegated launch leaves every run-tree column NULL", async () => {
    const taskId = await seedCarrierTask();

    await seedAcceptedRepositoryQualification(
      testDatabase.db,
      projectId,
      taskId,
    );

    const { runId } = await launchRun({ taskId, flowId }, EXT_CTX, db);

    const run = (
      await pool.query(
        `SELECT "parent_run_id", "root_run_id", "launch_mode", "delegation_snapshot"
           FROM "runs" WHERE "id" = $1`,
        [runId],
      )
    ).rows[0];

    expect(run.parent_run_id).toBeNull();
    expect(run.root_run_id).toBeNull();
    expect(run.launch_mode).toBeNull();
    expect(run.delegation_snapshot).toBeNull();
  }, 60_000);
});
