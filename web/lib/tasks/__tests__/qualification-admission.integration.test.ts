import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchRun } from "@/lib/services/runs";
import {
  prepareTaskDeliveryAdmission,
  assertTaskAdmissionForDispatch,
} from "@/lib/tasks/qualification-admission";
import {
  prepareTaskQualification,
  requireTaskRequalification,
} from "@/lib/tasks/qualification";
import { applyTriageVerdict } from "@/lib/services/triage";
import { qualificationFixture } from "@/test-support/task-qualification";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { initRepo, git } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_qualification_admission",
  });
  root = await mkdtempReal("qualification-admission-");
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("IT-UX-19 refuses unassessed delivery and legacy triage bypass, pins current readiness to its exact SHA, and rejects stale Pending admission without rewriting the frozen receipt", async () => {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const userId = randomUUID();
  const repo = await initRepo(path.join(root, projectId));

  await database.pool.query(
    "INSERT INTO users(id,email,role) VALUES ($1,$2,'member')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key,task_qualification_baseline) VALUES ($1,$1,'Qualification',$2,'QUALIFY','required')",
    [projectId, repo],
  );
  await database.pool.query(
    "UPDATE users SET must_change_password=false,account_status='active' WHERE id=$1",
    [userId],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), projectId, userId],
  );
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES ($1,$2,1,'Add explicit behavior','Clear acceptance criteria')",
    [taskId, projectId],
  );
  await expect(
    launchRun(
      { taskId, allowConcurrent: true },
      { actorUserId: userId, authorize: async () => undefined },
      database.db,
    ),
  ).rejects.toMatchObject({ details: { reason: "qualification_required" } });
  await expect(
    prepareTaskDeliveryAdmission(database.db, { projectId, taskId }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "qualification_required" },
  });
  await expect(
    database.db.transaction((tx) =>
      applyTriageVerdict(tx, {
        projectId,
        taskId,
        verdict: {},
        actor: { type: "user", id: userId },
        enqueue: true,
      }),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "qualification_required" },
  });
  const prepared = await prepareTaskQualification(database.db, {
    projectId,
    taskId,
    author: { kind: "user", identity: userId, userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: false,
    },
  });

  await database.db.transaction(prepared.apply);
  const admission = await prepareTaskDeliveryAdmission(database.db, {
    projectId,
    taskId,
  });
  const sha = (await git(repo, "rev-parse", "main")).trim();

  expect(admission.snapshot).toMatchObject({
    mode: "required",
    evidenceSha: sha,
    evidenceTarget: "main",
    inputRevision: 1,
  });
  expect(admission.baseCommit).toBe(sha);
  await database.db.transaction(admission.apply);
  const runId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,project_id,task_id,run_kind,flow_version,status,task_admission_snapshot) VALUES ($1,$2,$3,'flow','fixture','Pending',$4)",
    [runId, projectId, taskId, admission.snapshot],
  );
  await expect(
    prepareTaskDeliveryAdmission(database.db, {
      projectId,
      taskId,
      baseBranch: "other",
    }),
  ).rejects.toMatchObject({
    details: { reason: "qualification_target_changed" },
  });
  const activeRunId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,project_id,task_id,run_kind,flow_version,status,task_admission_snapshot) VALUES ($1,$2,$3,'flow','fixture','Running',$4)",
    [activeRunId, projectId, taskId, admission.snapshot],
  );
  await assertTaskAdmissionForDispatch(database.db, activeRunId);
  await database.pool.query(
    "UPDATE tasks SET prompt='A changed request' WHERE id=$1",
    [taskId],
  );
  await expect(
    assertTaskAdmissionForDispatch(database.db, activeRunId),
  ).resolves.toBeUndefined();
  await expect(database.db.transaction(admission.apply)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  await expect(
    assertTaskAdmissionForDispatch(database.db, runId),
  ).rejects.toMatchObject({ details: { reason: "qualification_stale" } });
  expect(
    (
      await database.pool.query(
        "SELECT task_admission_snapshot snapshot FROM runs WHERE id=$1",
        [runId],
      )
    ).rows[0].snapshot,
  ).toEqual(admission.snapshot);
  const oldWriter = new Pool({
    connectionString: database.databaseUrl,
    max: 1,
  });

  try {
    await expect(
      oldWriter.query("UPDATE tasks SET priority='high' WHERE id=$1", [taskId]),
    ).rejects.toMatchObject({
      constraint: "task_qualification_writer_capability",
    });
  } finally {
    await oldWriter.end();
  }
  const legacy = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Legacy',$2,'LEGACY')",
    [legacy, path.join(root, legacy)],
  );
  const legacyTask = randomUUID();

  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), legacy, userId],
  );
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES ($1,$2,1,'Existing behavior','Legacy')",
    [legacyTask, legacy],
  );
  expect(
    (
      await prepareTaskDeliveryAdmission(database.db, {
        projectId: legacy,
        taskId: legacyTask,
      })
    ).snapshot.mode,
  ).toBe("legacy");
  await database.db.transaction((tx) =>
    requireTaskRequalification(tx as unknown as Db, legacy, legacyTask),
  );
  await expect(
    prepareTaskDeliveryAdmission(database.db, {
      projectId: legacy,
      taskId: legacyTask,
    }),
  ).rejects.toMatchObject({ details: { reason: "qualification_required" } });
});

it("IT-UX-19 invalidates a ready assessment when the checked repository branch advances, before allocating any execution resource", async () => {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const userId = randomUUID();
  const repo = await initRepo(path.join(root, projectId));

  await database.pool.query(
    "INSERT INTO users(id,email,role) VALUES ($1,$2,'member')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key,task_qualification_baseline) VALUES ($1,$1,'Drift',$2,'DRIFT','required')",
    [projectId, repo],
  );
  await database.pool.query(
    "UPDATE users SET must_change_password=false,account_status='active' WHERE id=$1",
    [userId],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), projectId, userId],
  );
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES ($1,$2,1,'Request','Acceptance')",
    [taskId, projectId],
  );
  const qualification = await prepareTaskQualification(database.db, {
    projectId,
    taskId,
    author: { kind: "user", identity: userId, userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
    },
  });

  await database.db.transaction(qualification.apply);
  await writeFile(path.join(repo, "changed.txt"), "new implementation");
  await git(repo, "add", "changed.txt");
  await git(repo, "commit", "-m", "Change checked implementation");
  await expect(
    prepareTaskDeliveryAdmission(database.db, { projectId, taskId }),
  ).rejects.toMatchObject({
    details: { reason: "qualification_evidence_stale" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT current_qualification_id,launch_mode FROM tasks WHERE id=$1",
        [taskId],
      )
    ).rows[0],
  ).toEqual({ current_qualification_id: null, launch_mode: null });
  expect(
    (
      await database.pool.query("SELECT id FROM runs WHERE task_id=$1", [
        taskId,
      ])
    ).rows,
  ).toEqual([]);
});
