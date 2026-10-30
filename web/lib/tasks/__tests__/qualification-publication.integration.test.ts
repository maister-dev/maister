import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildAgentActivitySnapshot } from "@/lib/agents/activity-snapshot";
import { frozenOperationalDefinition } from "@/lib/agents/launch-contract";
import { runs } from "@/lib/db/schema";
import { prepareAgentRunFinalization } from "@/lib/agents/finalization";
import {
  captureOperationalBaseline,
  captureOperationalGeneration,
} from "@/lib/agents/operational-integrity";
import { operationalWorkspace } from "@/lib/agents/operational-context";
import { addDetachedWorktree } from "@/lib/worktree";
import { createTask, updateTask } from "@/lib/services/tasks";
import {
  loadTaskQualificationInput,
  prepareTaskQualification,
} from "@/lib/tasks/qualification";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { qualificationFixture } from "@/test-support/task-qualification";
import { operationalSuccessFixture } from "@/test-support/operational-agent";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
let root: string;
const oldRoot = process.env.MAISTER_WORKTREES_ROOT;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "qualification_publication",
  });
  db = database.db as Db;
  root = await mkdtempReal("qualification-publication-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  await fakeExecutionHosts(db);
}, 180_000);
afterAll(async () => {
  if (oldRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = oldRoot;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(snapshot?: null) {
  const templateId = await seedAgentRun(db, {
    runtimeRoot: root,
    workspace: "repo_read",
    resultContract: null,
    operational: true,
    definition:
      "---\nname: Qualifier\ndescription: qualify requests\nkind: operational\ncompletion: {contract: operational_v1}\ntask_qualification: {contract: v1, role: qualifier}\nmode: session\nworkspace: repo_read\nworkspace_ref: task_target\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nInspect the task.",
  });
  const [template] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, templateId));
  const runId = randomUUID();

  if (!template.projectId || !template.agentId)
    throw new Error("Fixture project missing");
  const run = {
    ...template,
    id: runId,
    projectId: template.projectId,
    executionAssignmentId: null,
  };

  await database.pool.query(
    "UPDATE projects SET task_qualification_override='required' WHERE id=$1",
    [run.projectId],
  );
  const task = await createTask(
    { title: "Feature", prompt: "Implement a precise behavior" },
    { projectId: run.projectId },
    db,
  );
  const context = await operationalWorkspace(db, run);

  await addDetachedWorktree({
    projectRepoPath: context.repoPath,
    worktreePath: context.cwd,
    committish: "main",
  });
  const baseline = await captureOperationalGeneration(
    context.cwd,
    await captureOperationalBaseline(context.cwd, "ephemeral_checkout"),
    [],
  );

  await db.insert(runs).values({
    ...run,
    taskId: task.taskId,
    sourceAgentId: template.agentId,
    agentActivitySnapshot: buildAgentActivitySnapshot(
      template.agentId,
      frozenOperationalDefinition(template)!,
    ),
    launchedAt: new Date(),
    activitySortAt: new Date(),
    activityTimestampProvenance: "launch",
    taskQualificationSnapshot:
      snapshot === null
        ? null
        : {
            version: 1,
            role: "qualifier",
            taskId: task.taskId,
            target: "main",
            sha: baseline.head,
          },
    operationalIntegrityBaseline: baseline,
  });
  const tokenId = randomUUID();

  await database.pool.query(
    "INSERT INTO project_tokens(id,project_id,name,prefix,token_hash,scopes,token_kind,agent_id) VALUES ($1,$2,$3,'fixture',$4,$6::jsonb,'agent',$5)",
    [
      tokenId,
      run.projectId,
      `agent-run:${runId}`,
      randomUUID(),
      run.agentId,
      JSON.stringify(["tasks:triage"]),
    ],
  );
  const flowId = randomUUID();

  await database.pool.query(
    "INSERT INTO flows(id,project_id,flow_ref_id,source,version,installed_path,manifest,schema_version,enablement_state,trust_status) VALUES ($1,$2,'fixture:delivery','local','v1','/unused','{}',1,'Enabled','trusted')",
    [flowId, run.projectId],
  );
  const submit = async () => {
    const input = await loadTaskQualificationInput(
      db,
      run.projectId,
      task.taskId,
    );
    const prepared = await prepareTaskQualification(db, {
      projectId: run.projectId,
      taskId: task.taskId,
      author: { kind: "agent_run", runId, tokenId },
      request: {
        requestKey: randomUUID(),
        expectedInputRevision: input.inputRevision,
        expectedQualificationRevision: input.currentQualificationRevision,
        qualification: qualificationFixture(),
        flowId,
        enqueue: true,
      },
    });

    return db.transaction(prepared.apply);
  };
  const finish = async (
    qualificationId?: string,
    outcome: "Done" | "Failed" | "Abandoned" | "Crashed" = "Done",
    malformed = false,
  ) =>
    prepareAgentRunFinalization(runId, outcome, {
      db: db,
      finalText: malformed
        ? "success"
        : `\`\`\`json maister:output\n${JSON.stringify({ ...operationalSuccessFixture(), references: qualificationId ? [{ kind: "other", id: qualificationId, state: "confirmed" }] : [] })}\n\`\`\``,
    });

  return {
    runId,
    taskId: task.taskId,
    projectId: run.projectId,
    tokenId,
    context,
    submit,
    finish,
  };
}
async function read(taskId: string) {
  return (
    await database.pool.query(
      "SELECT current_qualification_id,triage_status,launch_mode FROM tasks WHERE id=$1",
      [taskId],
    )
  ).rows[0];
}
it("IT-UX-22 publishes only with canonical clean terminal evidence, rolls back atomically and replays once", async () => {
  const f = await fixture();
  const candidate = await f.submit();

  expect(await read(f.taskId)).toMatchObject({
    current_qualification_id: null,
    launch_mode: null,
  });
  const prepared = await f.finish(candidate.qualificationId);

  await expect(
    db.transaction(async (tx) => {
      await prepared.apply(tx);
      throw new Error("Injected rollback");
    }),
  ).rejects.toThrow("Injected rollback");
  expect(await read(f.taskId)).toMatchObject({
    current_qualification_id: null,
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int n FROM run_results WHERE run_id=$1",
        [f.runId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(await db.transaction(prepared.apply)).toMatchObject({
    status: "Done",
  });
  expect(await read(f.taskId)).toMatchObject({
    current_qualification_id: candidate.qualificationId,
    triage_status: "triaged",
    launch_mode: "auto",
  });
  expect(await db.transaction(prepared.apply)).toEqual({ finalized: false });
  expect(
    (
      await database.pool.query(
        "SELECT publication_state FROM task_qualifications WHERE id=$1",
        [candidate.qualificationId],
      )
    ).rows[0].publication_state,
  ).toBe("accepted");
  const manual = await fixture();

  await database.pool.query(
    "UPDATE tasks SET launch_intent='none' WHERE id=$1",
    [manual.taskId],
  );
  const proposed = await manual.submit();
  const manualFinal = await manual.finish(proposed.qualificationId);

  expect(await db.transaction(manualFinal.apply)).toMatchObject({
    status: "Done",
  });
  expect(await read(manual.taskId)).toMatchObject({
    current_qualification_id: proposed.qualificationId,
    triage_status: "triaged",
    launch_mode: null,
  });
});
it("IT-UX-22 rejects unsafe, incomplete, stale and unauthorized evidence without enqueue", async () => {
  for (const variant of [
    "missing",
    "snapshot",
    "reference",
    "malformed",
    "dirty",
    "cancel",
    "crash",
    "edited",
    "revoked",
    "deleted",
    "failed",
  ] as const) {
    const f = await fixture(variant === "snapshot" ? null : undefined);
    const candidate =
      variant === "missing" || variant === "snapshot" ? null : await f.submit();

    if (variant === "dirty")
      await writeFile(
        path.join(f.context.cwd, "unexpected.ts"),
        "unexpected source",
      );
    if (variant === "edited")
      await updateTask(
        f.taskId,
        f.projectId,
        { prompt: "New requirements" },
        db,
      );
    if (variant === "revoked")
      await database.pool.query(
        "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
        [f.tokenId],
      );
    if (variant === "deleted")
      await database.pool.query(
        "DELETE FROM agents WHERE id=(SELECT agent_id FROM runs WHERE id=$1)",
        [f.runId],
      );
    const prepared = await f.finish(
      variant === "reference" ? undefined : candidate?.qualificationId,
      variant === "cancel"
        ? "Abandoned"
        : variant === "crash"
          ? "Crashed"
          : variant === "failed"
            ? "Failed"
            : "Done",
      variant === "malformed",
    );
    const receipt = await db.transaction(prepared.apply);

    expect(receipt, variant).toMatchObject({
      status:
        variant === "cancel"
          ? "Abandoned"
          : variant === "crash"
            ? "Crashed"
            : "Failed",
    });
    expect(await read(f.taskId), variant).toMatchObject({
      current_qualification_id: null,
      launch_mode: null,
    });
    if (candidate)
      expect(
        (
          await database.pool.query(
            "SELECT publication_state FROM task_qualifications WHERE id=$1",
            [candidate.qualificationId],
          )
        ).rows[0].publication_state,
        variant,
      ).toBe("rejected");
  }
});
it("IT-UX-22 serializes human and finalizer writers in both real lock orders without lost decisions", async () => {
  for (const humanFirst of [true, false]) {
    const f = await fixture();
    const candidate = await f.submit();
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,name,role,account_status,must_change_password) VALUES ($1,$2,'Reviewer','admin','active',false)",
      [userId, `${userId}@example.test`],
    );
    const input = await loadTaskQualificationInput(db, f.projectId, f.taskId);
    const value = {
      ...qualificationFixture(),
      decision: "needs_review" as const,
      reasonCodes: ["human_review"],
      nextActions: ["Review the intended behavior"],
    };
    const human = await prepareTaskQualification(db, {
      projectId: f.projectId,
      taskId: f.taskId,
      author: { kind: "user", identity: userId, userId },
      request: {
        requestKey: randomUUID(),
        expectedInputRevision: input.inputRevision,
        expectedQualificationRevision: null,
        qualification: value,
      },
    });
    const finish = await f.finish(candidate.qualificationId);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = db.transaction(async (tx) => {
      const result = await (humanFirst ? human.apply(tx) : finish.apply(tx));

      entered();
      await barrier;

      return result;
    });

    await locked;
    const second = db.transaction(async (tx) => {
      if (humanFirst) return await finish.apply(tx);

      return await human.apply(tx);
    });
    const captured = second.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

    release();
    await first;
    const later = await captured;

    if (humanFirst) {
      expect(later).toMatchObject({ value: { status: "Failed" } });
      expect((await read(f.taskId)).triage_status).toBe("flagged");
    } else {
      expect(later).toMatchObject({ error: { code: "CONFLICT" } });
      expect((await read(f.taskId)).current_qualification_id).toBe(
        candidate.qualificationId,
      );
    }
  }
});
