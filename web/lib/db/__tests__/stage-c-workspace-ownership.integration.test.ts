import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { sql } from "drizzle-orm";
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
  client: Pick<PoolClient, "query"> = database.pool,
): Promise<{ runId: string; assignmentId: string }> {
  const runId = randomUUID();
  const assignmentId = randomUUID();

  await client.query(
    `INSERT INTO runs (id, project_id, run_kind, status, flow_version, flow_revision)
     VALUES ($1, $2, 'scratch', $3, 'scratch', 'manual')`,
    [runId, projectId, status],
  );
  await client.query(
    `INSERT INTO execution_assignments
      (id, run_id, execution_host_id, epoch, state, placement_reason)
     VALUES ($1, $2, $3, 1, 'active', 'launch')`,
    [assignmentId, runId, host],
  );
  await client.query(
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
    "0378_reconcile_skipped_session_crashes",
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
    await applyMainMigration(tx, "0379_stage_c_workspace_ownership");
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

  it("upgrades a populated launch preparation through 0385 without rewriting the old identity", async () => {
    const preparation = {
      version: 2,
      kind: "agent",
      workspace: "none",
      runId: randomUUID(),
      taskAttemptNumber: 1,
      branch: null,
      parentRepoPath: null,
      baseCommit: null,
      worktreePath: "/tmp/stage-c-agent-workdir",
      runtimePath: "/tmp/stage-c-agent-workdir",
      resourceId: inputDigest,
      incarnationId: randomUUID(),
      inputDigest,
      settingsDigest: inputDigest,
    };
    await database.pool.query(
      `UPDATE task_launch_intents SET state='preparing', state_version=state_version+1, lease_token=$2,
        lease_expires_at=clock_timestamp()+interval '1 minute',
        preparation_phase='reserved', preparation_identity=$3 WHERE id=$1`,
      [retainedIntentId, randomUUID(), preparation],
    );
    const selectIntent = async () =>
      (
        await database.pool.query(
          "SELECT to_jsonb(task_launch_intents) AS document FROM task_launch_intents WHERE id=$1",
          [retainedIntentId],
        )
      ).rows[0]?.document;
    const original = await selectIntent();
    expect(original.preparation_identity).toEqual(preparation);
    await database.db.transaction(async (tx) => {
      for (const tag of [
        "0380_stage_c_prepare_command",
        "0381_stage_c_workspace_events",
        "0382_stage_c_workspace_inputs",
        "0383_stage_c_workspace_workloads",
        "0384_stage_c_workspace_requirement_probes",
        "0385_stage_c_addressed_launch_identity",
      ])
        await applyMainMigration(tx, tag);
    });
    expect(await selectIntent()).toEqual(original);
  });

  it("upgrades active assignment history and seals the first addressed Stop owner", async () => {
    const active = await createRun(hostId, "Running");
    const workspaceId = await reserveWorkspace({ ...active, host: hostId });
    const handle = `ws_${randomUUID().replaceAll("-", "")}`;
    await database.pool.query("UPDATE runs SET run_kind='flow' WHERE id=$1", [active.runId]);
    await database.pool.query("UPDATE workspaces SET execution_workspace_id=$2 WHERE id=$1", [workspaceId, handle]);
    await database.pool.query("UPDATE execution_assignments SET execution_workspace_id=$2 WHERE id=$1", [active.assignmentId, handle]);
    await database.db.transaction((tx) => applyMainMigration(tx, "0386_stage_c_addressed_stop"));
    const read = async () => (await database.pool.query(
      "SELECT state, run_id, execution_workspace_id, addressed_stop_requested_at, addressed_stop_requested_by FROM execution_assignments WHERE id=$1",
      [active.assignmentId],
    )).rows[0];
    expect(await read()).toEqual({
      state: "active", run_id: active.runId, execution_workspace_id: handle,
      addressed_stop_requested_at: null, addressed_stop_requested_by: null,
    });
    await database.pool.query(
      "UPDATE execution_assignments SET addressed_stop_requested_at=clock_timestamp(), addressed_stop_requested_by=$2 WHERE id=$1",
      [active.assignmentId, userId],
    );
    await expect(database.pool.query(
      "UPDATE execution_assignments SET addressed_stop_requested_by=$2 WHERE id=$1",
      [active.assignmentId, randomUUID()],
    )).rejects.toMatchObject({ code: "23514", constraint: "addressed_stop_immutable" });
    expect((await read()).addressed_stop_requested_by).toBe(userId);
  });

  it("upgrades retained command history and fences Git operations to their current owner", async () => {
    const active = await createRun(hostId, "Running");
    const workspaceId = await reserveWorkspace({ ...active, host: hostId });
    const handle = `ws_${randomUUID().replaceAll("-", "")}`;
    const checkpointId = randomUUID();
    const insertCommand = (id: string, kind: string, payload: Record<string, unknown>) =>
      database.pool.query(
        `INSERT INTO execution_commands
          (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
           kind, target_session_id, payload, max_attempts)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 3)`,
        [id, active.runId, active.assignmentId, hostId, kind, handle, payload],
      );
    await database.pool.query("UPDATE workspaces SET execution_workspace_id=$2 WHERE id=$1", [workspaceId, handle]);
    await database.pool.query("UPDATE execution_assignments SET execution_workspace_id=$2 WHERE id=$1", [active.assignmentId, handle]);
    const priorCommandId = randomUUID();
    await insertCommand(priorCommandId, "workspace.adopt", { fixture: "unchanged" });
    const readPriorCommand = async () => (await database.pool.query(
      "SELECT to_jsonb(command) AS record FROM execution_commands command WHERE id=$1", [priorCommandId],
    )).rows[0].record;
    const before = await readPriorCommand();
    await database.db.transaction((tx) => applyMainMigration(tx, "0387_stage_c_workspace_git_checkpoint"));
    expect(await readPriorCommand()).toEqual(before);

    await expect(insertCommand(checkpointId, "workspace.checkpoint", { generation: 2 })).rejects.toMatchObject({
      code: "23514", constraint: "workspace_git_command_owner_required",
    });
    await insertCommand(checkpointId, "workspace.checkpoint", { generation: 1 });
    const restoreId = randomUUID();
    const restore = { generation: 1, checkpointId };
    await expect(insertCommand(restoreId, "workspace.restore", restore)).rejects.toMatchObject({
      code: "23514", constraint: "workspace_restore_checkpoint_required",
    });
    await database.pool.query(
      `UPDATE execution_commands SET state='succeeded', completed_at=clock_timestamp(), result=$2 WHERE id=$1`,
      [checkpointId, { generation: 1, checkpointId, tree: sha }],
    );
    await insertCommand(restoreId, "workspace.restore", restore);
    await expect(database.pool.query(
      "UPDATE execution_commands SET payload=$2 WHERE id=$1", [restoreId, { ...restore, checkpointId: randomUUID() }],
    )).rejects.toMatchObject({ code: "23514", constraint: "workspace_git_command_immutable" });
  });

  it("upgrades a populated workspace and rejects placement under a substituted host or handle", async () => {
    const active = await createRun(hostId, "Running");
    const workspaceId = await reserveWorkspace({ ...active, host: hostId });
    const handle = `ws_${randomUUID().replaceAll("-", "")}`;
    await database.pool.query("UPDATE workspaces SET execution_workspace_id=$2 WHERE id=$1", [workspaceId, handle]);
    await database.pool.query("UPDATE execution_assignments SET execution_workspace_id=$2 WHERE id=$1", [active.assignmentId, handle]);
    const read = async () => (await database.pool.query(
      "SELECT to_jsonb(workspace) AS record FROM workspaces workspace WHERE id=$1", [workspaceId],
    )).rows[0].record;
    const before = await read();
    await database.db.transaction((tx) => applyMainMigration(tx, "0388_stage_c_inherited_workspace_ownership"));
    expect(await read()).toEqual(before);

    const insert = (owner: string, target: string) => database.pool.query(
      `INSERT INTO execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason, execution_workspace_id)
       VALUES ($1, $2, $3, 2, 'active', 'rework_return', $4)`,
      [randomUUID(), active.runId, owner, target],
    );
    const refused = { code: "23514", constraint: "addressed_assignment_inherited_owner_required" };
    await expect(insert(otherHostId, handle)).rejects.toMatchObject(refused);
    await expect(insert(hostId, `ws_${randomUUID().replaceAll("-", "")}`)).rejects.toMatchObject(refused);
  });

  it("upgrades a retained archive claim and requires its exact applied preservation before release", async () => {
    await database.db.transaction((tx) => applyMainMigration(tx, "0389_stage_c_retained_workspace_publication"));
    const run = await createRun(hostId, "Review");
    const workspaceId = await reserveWorkspace({ ...run, host: hostId });
    const handle = `ws_${randomUUID().replaceAll("-", "")}`;
    const claimId = randomUUID();
    await database.pool.query(`UPDATE workspaces SET execution_workspace_id=$2,
      lifecycle_operation_state='claiming', lifecycle_operation_name='archive',
      lifecycle_operation_expected_run_status='Review', lifecycle_operation_attempt_id=$3,
      lifecycle_operation_claimed_at=now(), lifecycle_operation_lease_expires_at=now()+interval '5 minutes'
      WHERE id=$1`, [workspaceId, handle, claimId]);
    await database.pool.query(`UPDATE execution_assignments SET execution_workspace_id=$2,
      state='released', ended_at=now(), released_reason='run_terminal' WHERE id=$1`, [run.assignmentId, handle]);
    const read = async () => (await database.pool.query("SELECT * FROM workspaces WHERE id=$1", [workspaceId])).rows[0];
    const before = await read();
    await database.db.transaction((tx) => applyMainMigration(tx, "0390_stage_c_retained_workspace_archive"));
    expect(await read()).toEqual(before);

    const preserveId = randomUUID();
    const releaseId = randomUUID();
    const owner = { claimId, generation: 1, fence: 1, quiescenceId: claimId };
    const reserve = (id: string, kind: string, payload: Record<string, unknown>) =>
      database.pool.query(`INSERT INTO execution_commands
        (id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,target_session_id,payload,max_attempts)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,3)`, [id, run.runId, run.assignmentId, hostId, kind, handle, payload]);
    const release = { ...owner, dispositionId: preserveId };
    await expect(reserve(releaseId, "workspace.release", release)).rejects.toMatchObject({
      constraint: "retained_workspace_preservation_required",
    });
    await reserve(preserveId, "workspace.preserve", { ...owner, disposition: "archive" });
    await expect(database.pool.query("UPDATE workspaces SET removed_at=now() WHERE id=$1", [workspaceId]))
      .rejects.toMatchObject({ constraint: "unsettled_workspace_archive" });
    await database.pool.query("UPDATE execution_commands SET state='succeeded',completed_at=now(),result=$2 WHERE id=$1",
      [preserveId, { ...owner, dispositionId: preserveId, retainedCommit: sha }]);
    await expect(reserve(releaseId, "workspace.release", { ...release, fence: 2 })).rejects.toMatchObject({
      constraint: "retained_workspace_preservation_required",
    });
    await reserve(releaseId, "workspace.release", release);
    await expect(reserve(randomUUID(), "workspace.release", release)).rejects.toMatchObject({
      constraint: "retained_workspace_preservation_required",
    });
    await database.pool.query("UPDATE execution_commands SET state='succeeded',completed_at=now(),result=$2 WHERE id=$1",
      [releaseId, { handle, generation: 1, dispositionId: preserveId }]);
    expect((await database.pool.query(`UPDATE workspaces SET removed_at=now(),archived_at=now(),
      archived_commit=$2,preservation_outcome='snapshot_created',removal_kind='archive' WHERE id=$1`, [workspaceId, sha])).rowCount).toBe(1);
  });

  it("preserves queued capture and recorded Stop owners through 0393 and 0394", async () => {
    await database.db.transaction(async (tx) => {
      await applyMainMigration(tx, "0391_stage_c_retained_workspace_sync");
      await applyMainMigration(tx, "0392_stage_c_addressed_retention");
    });
    const run = await createRun(hostId, "Pending");
    await database.pool.query("UPDATE runs SET run_kind='flow' WHERE id=$1", [run.runId]);
    const workspaceId = await reserveWorkspace({ ...run, host: hostId });
    await database.pool.query(
      `INSERT INTO workspace_input_captures (workspace_id, files, content_digest, requirement_probe_count)
       VALUES ($1, $2, $3, 1)`,
      [workspaceId, JSON.stringify([{ path: "frozen", base64: "YQ==" }]), inputDigest],
    );
    const read = async () => (
      await database.pool.query(
        "SELECT * FROM workspace_input_captures WHERE workspace_id=$1",
        [workspaceId],
      )
    ).rows[0];
    const original = await read();
    await database.db.transaction((tx) =>
      applyMainMigration(tx, "0393_stage_c_flow_setup_preflight"),
    );
    expect(await read()).toEqual({ ...original, flow_setup_revision_id: null });
    expect((await database.pool.query(
      `SELECT workspace_flow_setup_pending($1, flow_setup_revision_id) AS pending
       FROM workspace_input_captures WHERE workspace_id=$2`,
      [run.assignmentId, workspaceId],
    )).rows[0]).toEqual({ pending: false });
    const readStopOwners = async () => (
      await database.pool.query(
        `SELECT id,addressed_stop_requested_at,addressed_stop_requested_by
         FROM execution_assignments WHERE addressed_stop_requested_at IS NOT NULL ORDER BY id`,
      )
    ).rows;
    const stopOwners = await readStopOwners();
    expect(stopOwners.length).toBeGreaterThan(0);
    await database.db.transaction((tx) =>
      applyMainMigration(tx, "0394_stage_c_addressed_tree_stop"),
    );
    expect(await readStopOwners()).toEqual(stopOwners);
    await database.pool.query(
      `UPDATE execution_assignments SET addressed_stop_requested_at=now(),
       addressed_stop_requested_by='tree-stop-operator' WHERE id=$1`,
      [run.assignmentId],
    );
    await expect(database.pool.query(
      `UPDATE execution_assignments SET addressed_stop_requested_by='different-operator' WHERE id=$1`,
      [run.assignmentId],
    )).rejects.toMatchObject({ constraint: "addressed_stop_immutable" });
  });

  it("preserves populated legacy Agent preparation bytes through 0395", async () => {
    const retained = async () => (await database.pool.query(
      "SELECT to_jsonb(task_launch_intents) AS document FROM task_launch_intents WHERE id=$1",
      [retainedIntentId],
    )).rows[0]?.document;
    const before = await retained();
    expect(before.preparation_identity.version).toBe(2);
    await database.db.transaction((tx) =>
      applyMainMigration(tx, "0395_stage_c_addressed_agent_launch"),
    );
    expect(await retained()).toEqual(before);
  });

  it("preserves host ownership through 0396 and refuses singleton writers while a peer is retained", async () => {
    const readHistory = async () => (await database.pool.query(
      `SELECT h.id, h.host_key, h.transport, a.id AS assignment_id, a.run_id
       FROM execution_hosts h LEFT JOIN execution_assignments a ON a.execution_host_id=h.id ORDER BY h.id,a.id`,
    )).rows;
    const before = await readHistory();
    expect(before.some(({ assignment_id }) => assignment_id !== null)).toBe(true);
    await database.db.transaction((tx) =>
      applyMainMigration(tx, "0396_execution-host-peer-registry"),
    );
    expect(await readHistory()).toEqual(before);
    await database.pool.query("UPDATE execution_hosts SET display_name=display_name WHERE id=$1", [hostId]);
    const secondary = randomUUID();
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('maister.execution_host_registry_writer', 'v2', true)`);
      await tx.execute(sql`INSERT INTO execution_hosts (id, host_key, kind, display_name, transport)
        VALUES (${secondary}, ${`eh_${secondary.replaceAll("-", "")}`}, 'local_direct', 'Peer fixture',
          '{"kind":"local_direct","role":"secondary"}'::jsonb)`);
    });
    await expect(database.pool.query(
      "UPDATE execution_hosts SET display_name=display_name WHERE id=$1", [hostId],
    )).rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("registry writer") });
    await expect(database.pool.query(
      `INSERT INTO execution_assignments (id, run_id, execution_host_id, epoch, state, placement_reason)
       VALUES ($1,$2,$3,2,'active','launch')`,
      [randomUUID(), before.find(({ run_id }) => run_id !== null)?.run_id, secondary],
    )).rejects.toMatchObject({ code: "P0001", message: expect.stringContaining("registry writer") });
  });

  it("backfills the existing addressed owner through 0397 without reserving a pending run", async () => {
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('maister.execution_host_registry_writer', 'v2', true)`);
      await tx.execute(sql`UPDATE execution_hosts SET capabilities = capabilities || '{"workspaceProtocol":[1]}'::jsonb WHERE id=${hostId}`);
    });
    const client = await database.pool.connect();
    const { running, pending } = await (async () => {
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL maister.execution_host_registry_writer='v2'");
        const running = await createRun(hostId, "Running", client);
        const pending = await createRun(hostId, "Pending", client);
        await client.query("COMMIT");
        return { running, pending };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })();
    const startedAt = new Date("2026-01-12T12:00:00.000Z");
    await database.pool.query("UPDATE runs SET started_at=$1 WHERE id=$2", [startedAt, running.runId]);
    const history = async () => (await database.pool.query(
      "SELECT to_jsonb(a) AS assignment FROM execution_assignments a WHERE id=ANY($1::text[]) ORDER BY id",
      [[running.assignmentId, pending.assignmentId]],
    )).rows;
    const before = await history();
    await database.db.transaction((tx) => applyMainMigration(tx, "0397_stage-c-host-capacity"));
    expect(await history()).toEqual(before);
    const slots = await database.pool.query(
      "SELECT assignment_id, reserved_at FROM execution_host_slot_reservations WHERE assignment_id=ANY($1::text[])",
      [[running.assignmentId, pending.assignmentId]],
    );
    expect(slots.rows).toEqual([{ assignment_id: running.assignmentId, reserved_at: startedAt }]);
  });
});
