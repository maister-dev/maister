import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTask, updateTask } from "@/lib/services/tasks";
import { initRepo, git } from "@/test-support/git-fixture";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { qualificationFixture } from "@/test-support/task-qualification";
import {
  prepareTaskQualification,
  applyProjectQualificationConfig,
  loadTaskQualificationInput,
  requireTaskRequalification,
} from "@/lib/tasks/qualification";
import {
  normalizedManifest,
  patchProjectManifest,
} from "@/lib/project-config-persistence/manifest";
import { readExportSnapshot } from "@/lib/project-config-persistence/projection";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const repositories: string[] = [];

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_qualification",
  });
}, 180_000);
afterAll(async () => {
  await database?.stop();
  for (const repository of repositories)
    await rm(repository, { recursive: true, force: true });
});

describe("Task qualification storage", () => {
  it("IT-UX-18 holds independently created requests and invalidates semantic edits without reclassifying legacy work", async () => {
    const projectId = randomUUID();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key,task_qualification_baseline) VALUES ($1,$1,'Qualification',$2,'/unused/config','QUALIFY','required')",
      [projectId, `/unused/${projectId}`],
    );
    const task = await createTask(
      { title: "Implement a feature", prompt: "Add the documented behavior" },
      { projectId },
      database.db,
    );
    const read = async () =>
      (
        await database.pool.query(
          "SELECT qualification_mode,qualification_input_revision,current_qualification_id,launch_mode FROM tasks WHERE id=$1",
          [task.taskId],
        )
      ).rows[0];

    expect(await read()).toMatchObject({
      qualification_mode: "required",
      qualification_input_revision: 1,
      current_qualification_id: null,
    });
    await updateTask(task.taskId, projectId, { priority: "high" }, database.db);
    expect((await read()).qualification_input_revision).toBe(1);
    await updateTask(
      task.taskId,
      projectId,
      { prompt: "Changed requirement" },
      database.db,
    );
    expect((await read()).qualification_input_revision).toBe(2);
    await database.pool.query(
      "UPDATE projects SET task_qualification_override='legacy' WHERE id=$1",
      [projectId],
    );
    expect((await read()).qualification_mode).toBe("required");
    const legacy = await createTask(
      { title: "Legacy request", prompt: "Existing policy" },
      { projectId },
      database.db,
    );

    expect(
      (
        await database.pool.query(
          "SELECT qualification_mode FROM tasks WHERE id=$1",
          [legacy.taskId],
        )
      ).rows[0].qualification_mode,
    ).toBe("legacy");
  });
  it("IT-UX-18 refuses an over-limit clarification input without accepting a truncated digest", async () => {
    const projectId = randomUUID();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Bounded',$2,'BOUND')",
      [projectId, `/unused/${projectId}`],
    );
    const task = await createTask(
      {
        title: "Bounded input",
        prompt: "Inspect all applicable clarification evidence",
      },
      { projectId },
      database.db,
    );

    await database.pool.query(
      "INSERT INTO task_clarifications(id,task_id,seq,origin_kind,question,retrigger_mode,blocking,requester_user_id,recipient_user_id,reason,answer_format) SELECT $1 || '-' || n::text,$1,n,'user','Clarify requirement','none',true,'fixture-user','fixture-user','Confirm scope','text' FROM generate_series(1,1001) n",
      [task.taskId],
    );
    await expect(
      loadTaskQualificationInput(database.db, projectId, task.taskId),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "qualification_input_limit", maximum: 1000 },
    });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM task_qualifications WHERE task_id=$1",
          [task.taskId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("IT-UX-18 keeps SET/CLEAR policy symmetry and validates immutable acceptance against the current task", async () => {
    const projectId = randomUUID();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key) VALUES ($1,$1,'Policy',$2,'/unused/config','POLICY')",
      [projectId, `/unused/${projectId}`],
    );
    await applyProjectQualificationConfig(database.db, projectId, {
      task_qualification: "required",
    });
    const exported = await readExportSnapshot(database.db, projectId);
    const manifest = patchProjectManifest(null, exported.projection);

    expect(normalizedManifest(manifest).taskQualificationOverride).toBe(
      "required",
    );
    const task = await createTask(
      {
        title: "Request",
        prompt: "Implement a behavior with clear acceptance",
      },
      { projectId },
      database.db,
    );

    await applyProjectQualificationConfig(database.db, projectId, {});
    const [cleared] = (
      await database.pool.query(
        "SELECT task_qualification_baseline,task_qualification_override FROM projects WHERE id=$1",
        [projectId],
      )
    ).rows;

    expect(cleared).toEqual({
      task_qualification_baseline: "legacy",
      task_qualification_override: null,
    });
    const clearedExport = await readExportSnapshot(database.db, projectId);

    expect(
      normalizedManifest(
        patchProjectManifest(manifest, clearedExport.projection),
      ).taskQualificationOverride,
    ).toBeNull();
    await expect(
      database.pool.query(
        "UPDATE projects SET task_qualification_baseline='required' WHERE id=$1",
        [projectId],
      ),
    ).rejects.toMatchObject({
      constraint: "projects_qualification_baseline_immutable",
    });
    const input = await loadTaskQualificationInput(
      database.db,
      projectId,
      task.taskId,
    );
    const qualificationId = randomUUID();

    await database.db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE tasks SET qualification_revision_counter=1 WHERE id=${task.taskId}`,
      );
      await tx.execute(
        sql`INSERT INTO task_qualifications(id,project_id,task_id,revision,input_revision,input_digest,request_key,payload_digest,author_kind,author_identity,evidence_target,evidence_sha,value,routing,publication_state,published_at) VALUES (${qualificationId},${projectId},${task.taskId},1,${input.inputRevision},${input.inputDigest},${randomUUID()},${"a".repeat(64)},'project_token','verified-human-token','main',${"a".repeat(40)},${JSON.stringify(qualificationFixture())}::jsonb,'{"flowId":null,"runnerId":null,"baseBranch":null,"enqueue":false}'::jsonb,'accepted',now())`,
      );
      await tx.execute(
        sql`UPDATE tasks SET current_qualification_id=${qualificationId},current_qualification_revision=1,launch_mode='auto',launch_armed_at=now() WHERE id=${task.taskId}`,
      );
    });
    const invalidReady = {
      ...qualificationFixture(),
      checks: qualificationFixture().checks.map((check) =>
        check.dimension === "consistency"
          ? { ...check, state: "unknown" as const }
          : check,
      ),
    };

    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE tasks SET qualification_revision_counter=2 WHERE id=${task.taskId}`,
        );
        await tx.execute(
          sql`INSERT INTO task_qualifications(project_id,task_id,revision,input_revision,input_digest,request_key,payload_digest,author_kind,author_identity,evidence_target,evidence_sha,value,routing,publication_state,published_at) VALUES (${projectId},${task.taskId},2,${input.inputRevision},${input.inputDigest},${randomUUID()},${"a".repeat(64)},'user','trusted-human','main',${"a".repeat(40)},${JSON.stringify(invalidReady)}::jsonb,'{}'::jsonb,'accepted',now())`,
        );
      }),
    ).rejects.toMatchObject({
      cause: { constraint: "task_qualification_shape_check" },
    });
    expect(
      (
        await database.pool.query(
          "SELECT qualification_revision_counter FROM tasks WHERE id=$1",
          [task.taskId],
        )
      ).rows[0].qualification_revision_counter,
    ).toBe(1);
    await expect(
      database.pool.query(
        "UPDATE task_qualifications SET value=jsonb_set(value,'{nextActions}','[\"Changed content\"]') WHERE id=$1",
        [qualificationId],
      ),
    ).rejects.toMatchObject({
      constraint: "task_qualification_content_immutable",
    });
    await updateTask(
      task.taskId,
      projectId,
      { priority: "urgent", queuePaused: true },
      database.db,
    );
    expect(
      (await loadTaskQualificationInput(database.db, projectId, task.taskId))
        .currentQualificationId,
    ).toBe(qualificationId);
    await updateTask(
      task.taskId,
      projectId,
      { prompt: "Amended requirement" },
      database.db,
    );
    const changed = await loadTaskQualificationInput(
      database.db,
      projectId,
      task.taskId,
    );

    expect(changed.inputRevision).toBe(input.inputRevision + 1);
    expect(changed.inputDigest).not.toBe(input.inputDigest);
    expect(changed.currentQualificationId).toBeNull();
    expect(
      (
        await database.pool.query(
          "SELECT launch_mode,launch_armed_at FROM tasks WHERE id=$1",
          [task.taskId],
        )
      ).rows[0],
    ).toEqual({ launch_mode: null, launch_armed_at: null });
    await expect(
      database.pool.query(
        "UPDATE tasks SET current_qualification_id=$2,current_qualification_revision=1 WHERE id=$1",
        [task.taskId, qualificationId],
      ),
    ).rejects.toMatchObject({
      constraint: "tasks_qualification_pointer_scope",
    });
    await requireTaskRequalification(database.db, projectId, task.taskId);
    expect(
      (await loadTaskQualificationInput(database.db, projectId, task.taskId))
        .inputRevision,
    ).toBe(changed.inputRevision + 1);
  });

  it("IT-UX-18 serializes human acceptance, replays obsolete request receipts and rejects conflicting or malformed assessments", async () => {
    const repository = await mkdtempReal("qualification-repo-");

    repositories.push(repository);
    const repoPath = await initRepo(repository);
    const projectId = randomUUID();
    const userId = randomUUID();

    await database.pool.query("INSERT INTO users(id,email) VALUES ($1,$2)", [
      userId,
      `${userId}@example.test`,
    ]);
    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key) VALUES ($1,$1,'Human qualification',$2,'/unused/config','HUMAN')",
      [projectId, repoPath],
    );
    const task = await createTask(
      { title: "Clear request", prompt: "Implement the specified behavior" },
      { projectId },
      database.db,
    );
    const author = { kind: "user" as const, identity: userId, userId };
    const request = {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: true,
    };
    const prepared = await prepareTaskQualification(database.db, {
      projectId,
      taskId: task.taskId,
      author,
      request,
    });
    const accepted = await database.db.transaction(prepared.apply);

    expect(accepted).toMatchObject({
      inputRevision: 1,
      qualificationRevision: 1,
      publicationState: "accepted",
      decision: "ready",
    });
    expect(
      (await loadTaskQualificationInput(database.db, projectId, task.taskId))
        .mode,
    ).toBe("required");
    expect(
      (
        await database.pool.query("SELECT launch_mode FROM tasks WHERE id=$1", [
          task.taskId,
        ])
      ).rows[0].launch_mode,
    ).toBeNull();
    await updateTask(
      task.taskId,
      projectId,
      { prompt: "Amended request" },
      database.db,
    );
    await git(repoPath, "branch", "-m", "main", "archived-main");
    const replay = await prepareTaskQualification(database.db, {
      projectId,
      taskId: task.taskId,
      author,
      request,
    });

    expect(await database.db.transaction(replay.apply)).toEqual(accepted);
    await expect(
      prepareTaskQualification(database.db, {
        projectId,
        taskId: task.taskId,
        author,
        request: {
          ...request,
          qualification: {
            ...request.qualification,
            nextActions: ["Changed payload"],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "qualification_request_conflict" },
    });
    const held = {
      ...qualificationFixture(),
      decision: "needs_review" as const,
      reasonCodes: ["runtime_evidence_missing"],
      nextActions: ["Provide observed runtime evidence"],
      checks: qualificationFixture().checks.map((check) =>
        check.dimension === "relevance"
          ? { ...check, state: "unknown" as const }
          : check,
      ),
    };
    const concurrent = await Promise.all(
      [0, 1].map(() =>
        prepareTaskQualification(database.db, {
          projectId,
          taskId: task.taskId,
          author,
          request: {
            requestKey: randomUUID(),
            expectedInputRevision: 2,
            expectedQualificationRevision: null,
            qualification: held,
          },
        }),
      ),
    );
    const results = await Promise.allSettled(
      concurrent.map((submission) => database.db.transaction(submission.apply)),
    );

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toMatchObject([
      {
        status: "rejected",
        reason: {
          code: "CONFLICT",
          details: { reason: "qualification_stale" },
        },
      },
    ]);
    const current = await loadTaskQualificationInput(
      database.db,
      projectId,
      task.taskId,
    );

    expect(current).toMatchObject({
      inputRevision: 2,
      currentQualificationRevision: 2,
    });
    const malformed = {
      ...held,
      checks: held.checks.map((check) => ({
        ...check,
        dimension: "goal_scope" as const,
      })),
    };

    await expect(
      prepareTaskQualification(database.db, {
        projectId,
        taskId: task.taskId,
        author,
        request: {
          requestKey: randomUUID(),
          expectedInputRevision: 2,
          expectedQualificationRevision: 2,
          qualification: malformed,
        },
      }),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "qualification_invalid" },
    });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM task_qualifications WHERE task_id=$1",
          [task.taskId],
        )
      ).rows[0].n,
    ).toBe(2);
    const clarificationId = randomUUID();

    await database.pool.query(
      "INSERT INTO task_clarifications(id,task_id,seq,origin_kind,question,retrigger_mode,requester_user_id,recipient_user_id,reason,answer_format,blocking) VALUES ($1,$2,1,'user','Which environment?','none',$3,$3,'Missing environment','text',true)",
      [clarificationId, task.taskId, userId],
    );
    expect(
      await loadTaskQualificationInput(database.db, projectId, task.taskId),
    ).toMatchObject({ inputRevision: 3, currentQualificationId: null });
    await database.pool.query(
      "UPDATE task_clarifications SET status='answered',answer='\"Production\"'::jsonb,answered_at=now(),answered_by_user_id=$2 WHERE id=$1",
      [clarificationId, userId],
    );
    expect(
      (await loadTaskQualificationInput(database.db, projectId, task.taskId))
        .inputRevision,
    ).toBe(4);
    await database.pool.query(
      "UPDATE projects SET main_branch='next' WHERE id=$1",
      [projectId],
    );
    expect(
      (await loadTaskQualificationInput(database.db, projectId, task.taskId))
        .inputRevision,
    ).toBe(5);
    await database.pool.query(
      "UPDATE tasks SET qualification_source_version='github:updated:2' WHERE id=$1",
      [task.taskId],
    );
    expect(
      (await loadTaskQualificationInput(database.db, projectId, task.taskId))
        .inputRevision,
    ).toBe(6);
    const rollback = new Error("Rollback semantic edit and its event");
    const events = (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM domain_events WHERE task_id=$1",
        [task.taskId],
      )
    ).rows[0].n;

    await expect(
      database.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE tasks SET prompt='Uncommitted requirement' WHERE id=${task.taskId}`,
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(
      (await loadTaskQualificationInput(database.db, projectId, task.taskId))
        .inputRevision,
    ).toBe(6);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM domain_events WHERE task_id=$1",
          [task.taskId],
        )
      ).rows[0].n,
    ).toBe(events);
  });
});
