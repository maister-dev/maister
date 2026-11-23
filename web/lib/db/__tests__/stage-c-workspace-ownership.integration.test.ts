import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMainMigration,
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const projectId = randomUUID();
const hostId = randomUUID();
const otherHostId = randomUUID();
const inputDigest = "a".repeat(64);
const userId = randomUUID();
const taskId = randomUUID();
const retainedIntentId = randomUUID();
const sha = "b".repeat(40);
let database: StartedPostgresTestDb;
let originalWorkspaces: Record<string, unknown>[];
let originalIntent: Record<string, unknown>;

async function createRun(
  host: string,
  status: "Pending" | "Running" | "Review" = "Pending",
): Promise<{ runId: string; assignmentId: string }> {
  const runId = randomUUID();
  const assignmentId = randomUUID();

  await database.pool.query(
    `INSERT INTO runs (id, project_id, run_kind, status, flow_version, flow_revision)
     VALUES ($1, $2, 'scratch', $3, 'scratch', 'manual')`,
    [runId, projectId, status],
  );
  await database.pool.query(
    `INSERT INTO execution_assignments
      (id, run_id, execution_host_id, epoch, state, placement_reason)
     VALUES ($1, $2, $3, 1, 'active', 'launch')`,
    [assignmentId, runId, host],
  );
  await database.pool.query(
    "UPDATE runs SET execution_assignment_id = $2 WHERE id = $1",
    [runId, assignmentId],
  );

  return { runId, assignmentId };
}

async function reserveWorkspace(input: {
  runId: string;
  assignmentId: string;
  host: string;
  rootWorkspaceId?: string;
}): Promise<string> {
  const id = randomUUID();

  await database.pool.query(
    `INSERT INTO workspaces
      (id, project_id, run_id, branch, ownership_kind, execution_host_id,
       preparation_assignment_id, workspace_generation, workspace_input_digest, root_workspace_id)
     VALUES ($1, $2, $3, 'maister/fixture', 'host_owned', $4, $5, 1, $6, $7)`,
    [
      id,
      projectId,
      input.runId,
      input.host,
      input.assignmentId,
      inputDigest,
      input.rootWorkspaceId ?? null,
    ],
  );

  return id;
}

async function insertQueuedLaunch(input: {
  intentId: string;
  sourceTaskId: string;
  selection?: { hostId: string; revision: string };
}): Promise<void> {
  const result = await database.pool.query<{
    qualification_input_revision: number;
    revision: number;
  }>(
    `INSERT INTO tasks (id, project_id, number, title, prompt)
     VALUES ($1, $2, $3, 'Preserve the frozen task', 'Keep exact bytes')
     RETURNING qualification_input_revision, revision`,
    [input.sourceTaskId, projectId, input.selection ? 2 : 1],
  );
  const [task] = result.rows;
  const frozenInput = {
    version: 2,
    projectId,
    taskId: input.sourceTaskId,
    number: input.selection ? 2 : 1,
    title: "Preserve the frozen task",
    prompt: "Keep exact bytes",
    statementRevision: null,
    sourceVersion: 1,
    target: "main",
    deliveryTarget: "main",
    clarifications: [],
  };
  const settings = {
    version: 2,
    kind: "agent",
    workspace: "none",
    agentId: randomUUID(),
    definitionSha256: inputDigest,
    flowId: null,
    flowRefId: null,
    flowRevisionId: null,
    packageInstallId: null,
    sessions: [
      {
        sessionName: "default",
        runnerId: "fixture",
        runnerSnapshot: { id: "fixture" },
        runnerConfigDigest: inputDigest,
      },
    ],
    baseBranch: "main",
    baseCommit: null,
    targetBranch: "main",
    promotionMode: "local_merge",
    autoPromote: false,
    deliveryPolicy: {},
    executionPolicy: {},
    taskSettingsDigest: inputDigest,
    resolutionToken: inputDigest,
    capabilityResolutionDigest: inputDigest,
    resolvedCapabilitySet: null,
  };
  const columns = input.selection
    ? ", requested_execution_host_id, effective_execution_host_id, execution_host_provenance, execution_host_eligibility_revision"
    : "";
  const selectionValues = input.selection ? ", $10, $10, 'explicit', $11" : "";

  await database.pool.query(
    `INSERT INTO task_launch_intents
     (id, project_id, task_id, principal_kind, principal_id, actor_user_id, launch_source, operation,
      request_key, payload_digest, task_revision, input_revision, input_digest, input_snapshot,
      settings_digest, settings_snapshot, basis, due_at${columns})
     VALUES ($1, $2, $3, 'session_user', $4, $4, 'web', 'launch', $1, $5, $6, $7, $5, $8, $5, $9,
       jsonb_build_object('kind', 'manual', 'userId', $4::text), clock_timestamp()${selectionValues})`,
    [
      input.intentId,
      projectId,
      input.sourceTaskId,
      userId,
      inputDigest,
      task.revision,
      task.qualification_input_revision,
      frozenInput,
      settings,
      ...(input.selection
        ? [input.selection.hostId, input.selection.revision]
        : []),
    ],
  );
}

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "stage_c_workspace_ownership" },
    "0369_reconcile_skipped_session_crashes",
  );
  await declareCurrentTestDatabaseWriter(database);
  await database.pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, task_key)
     VALUES ($1, 'stage-c-fixture', 'Stage C fixture', '/tmp/stage-c-fixture', 'STGC')`,
    [projectId],
  );
  await database.pool.query(
    `INSERT INTO execution_hosts (id, host_key, kind, display_name, transport, retired_at)
     VALUES ($1, 'eh_stage_c_primary', 'local_direct', 'Primary', '{"kind":"local_direct"}', NULL),
            ($2, 'eh_stage_c_history', 'local_direct', 'Historical', '{"kind":"local_direct"}', now())`,
    [hostId, otherHostId],
  );
  const running = await createRun(hostId, "Running");
  const retained = await createRun(otherHostId, "Review");
  await database.pool.query(
    `UPDATE execution_assignments SET execution_workspace_id=$1 WHERE id IN ($2, $3)`,
    ["ws_" + "2".repeat(32), running.assignmentId, retained.assignmentId],
  );
  await database.pool.query(
    `UPDATE execution_assignments SET state='released', ended_at=now() WHERE id=$1`,
    [retained.assignmentId],
  );
  const ambiguous = await createRun(hostId, "Review");
  await database.pool.query(
    "UPDATE runs SET execution_assignment_id = NULL WHERE id = $1",
    [ambiguous.runId],
  );
  await database.pool.query("DELETE FROM execution_assignments WHERE id = $1", [
    ambiguous.assignmentId,
  ]);

  for (const [label, run] of Object.entries({ running, retained, ambiguous })) {
    await database.pool.query(
      `INSERT INTO workspaces(id, run_id, project_id, branch, worktree_path, parent_repo_path, base_commit)
       VALUES ($1, $2, $3, $4, $5, '/tmp/stage-c-fixture', $6)`,
      [
        randomUUID(),
        run.runId,
        projectId,
        "maister/" + label,
        "/tmp/worktrees/" + label,
        sha,
      ],
    );
  }
  await database.pool.query(
    "INSERT INTO users(id, email, role) VALUES ($1, 'stage-c@test.local', 'admin')",
    [userId],
  );
  await insertQueuedLaunch({
    intentId: retainedIntentId,
    sourceTaskId: taskId,
  });
  originalWorkspaces = (
    await database.pool.query<Record<string, unknown>>(
      "SELECT * FROM workspaces ORDER BY id",
    )
  ).rows;
  originalIntent = (
    await database.pool.query<Record<string, unknown>>(
      "SELECT * FROM task_launch_intents WHERE id = $1",
      [retainedIntentId],
    )
  ).rows[0];

  await database.db.transaction(async (tx) => {
    await applyMainMigration(tx, "0370_stage_c_workspace_ownership");
  });
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe("C-02 workspace ownership", () => {
  it("upgrades active and retained history without claiming a remote owner or rewriting old bytes", async () => {
    const { rows: history } = await database.pool.query(
      "SELECT * FROM workspaces WHERE id = ANY($1::text[]) ORDER BY id",
      [originalWorkspaces.map((row) => row.id)],
    );
    expect(history).toEqual(
      originalWorkspaces.map((row) => ({
        ...row,
        ownership_kind: "legacy_path",
        execution_host_id: null,
        execution_workspace_id: null,
        preparation_assignment_id: null,
        workspace_generation: null,
        workspace_input_digest: null,
        root_workspace_id: null,
        legacy_host_adoption_issue:
          row.branch === "maister/ambiguous" ? "owner_unverified" : null,
      })),
    );
    const { rows } = await database.pool.query(
      "SELECT * FROM task_launch_intents WHERE id = $1",
      [retainedIntentId],
    );
    expect(rows[0]).toEqual({
      ...originalIntent,
      requested_execution_host_id: null,
      effective_execution_host_id: null,
      execution_host_provenance: null,
      execution_host_eligibility_revision: null,
    });
    await expect(
      database.pool.query(
        `UPDATE task_launch_intents SET effective_execution_host_id=$2,
         execution_host_provenance='instanceDefault', execution_host_eligibility_revision=$3 WHERE id=$1`,
        [retainedIntentId, hostId, inputDigest],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "task_launch_intents_host_selection_immutable",
    });
  });

  it("reserves a logical workspace before checkout without a Web-local path", async () => {
    const { runId, assignmentId } = await createRun(hostId);
    await expect(
      reserveWorkspace({ runId, assignmentId, host: otherHostId }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "workspaces_preparation_assignment_fk",
    });
    const id = await reserveWorkspace({ runId, assignmentId, host: hostId });
    const { rows } = await database.pool.query(
      `SELECT ownership_kind, worktree_path, parent_repo_path, execution_host_id,
              execution_workspace_id, preparation_assignment_id, workspace_generation
         FROM workspaces WHERE id = $1`,
      [id],
    );

    expect(rows).toEqual([
      {
        ownership_kind: "host_owned",
        worktree_path: null,
        parent_repo_path: null,
        execution_host_id: hostId,
        execution_workspace_id: null,
        preparation_assignment_id: assignmentId,
        workspace_generation: 1,
      },
    ]);
  });

  it("serializes competing reservations and keeps shared children on their root's host", async () => {
    const root = await createRun(hostId);
    const racers = await Promise.allSettled([
      reserveWorkspace({ ...root, host: hostId }),
      reserveWorkspace({ ...root, host: hostId }),
    ]);
    const winner = racers.find((result) => result.status === "fulfilled");
    const loser = racers.find((result) => result.status === "rejected");

    expect(loser?.reason).toMatchObject({
      code: "23505",
      constraint: "workspaces_active_host_run_uq",
    });
    if (!winner) throw new Error("No reservation won");
    const childOnOtherHost = await createRun(otherHostId);
    await expect(
      reserveWorkspace({
        ...childOnOtherHost,
        host: otherHostId,
        rootWorkspaceId: winner.value,
      }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "workspaces_root_host_fk",
    });
    const child = await createRun(hostId);
    await expect(
      reserveWorkspace({
        ...child,
        host: hostId,
        rootWorkspaceId: winner.value,
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it("retains a selected host even when the project default changes", async () => {
    const intentId = randomUUID();
    await insertQueuedLaunch({
      intentId,
      sourceTaskId: randomUUID(),
      selection: { hostId, revision: inputDigest },
    });
    await database.pool.query(
      `UPDATE projects SET default_execution_host_id=$2,
         execution_host_preference_revision=execution_host_preference_revision+1 WHERE id=$1`,
      [projectId, otherHostId],
    );
    const { rows } = await database.pool.query(
      `SELECT requested_execution_host_id, effective_execution_host_id, execution_host_provenance,
              execution_host_eligibility_revision FROM task_launch_intents WHERE id=$1`,
      [intentId],
    );
    expect(rows[0]).toEqual({
      requested_execution_host_id: hostId,
      effective_execution_host_id: hostId,
      execution_host_provenance: "explicit",
      execution_host_eligibility_revision: inputDigest,
    });
    await expect(
      database.pool.query(
        "UPDATE task_launch_intents SET effective_execution_host_id=$2 WHERE id=$1",
        [intentId, otherHostId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "task_launch_intents_host_selection_immutable",
    });
  });
});
