import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskAdmissionSnapshot,
  TaskExecutionChildProof,
} from "@/lib/tasks/qualification-types";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { projects, runs, tasks, taskQualifications } from "@/lib/db/schema";
import {
  loadTaskQualificationInput,
  requireTaskRequalification,
} from "@/lib/tasks/qualification";
import { resolveBaseCommit } from "@/lib/worktree";
import { MaisterError } from "@/lib/errors";
import { retryDigest } from "@/lib/agents/retry-guards";
import { AGENT_EXECUTION_STATUS } from "@/lib/agents/activity-status";

const log = pino({
  name: "task-qualification-admission",
  level: process.env.LOG_LEVEL ?? "info",
});

function qualificationRefusal(
  reason: string,
  code: "PRECONDITION" | "CONFLICT" = "PRECONDITION",
): MaisterError {
  return new MaisterError(
    code,
    `Task delivery requires current qualification: ${reason}`,
    { details: { reason } },
  );
}

export type PreparedTaskDeliveryAdmission = {
  snapshot: TaskAdmissionSnapshot;
  baseCommit: string | null;
  apply: (tx: Db) => Promise<TaskAdmissionSnapshot>;
};

async function readAdmission(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<TaskAdmissionSnapshot> {
  const input = await loadTaskQualificationInput(db, projectId, taskId);
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  const base: TaskAdmissionSnapshot = {
    version: 1,
    mode: input.mode,
    policyVersion: 1,
    inputRevision: input.inputRevision,
    qualificationId: null,
    qualificationRevision: null,
    evidenceTarget: null,
    evidenceSha: null,
    parent: null,
  };

  if (input.mode === "legacy") return base;
  if (input.mode === "execution_child") {
    if (
      !task.qualificationChildProof ||
      task.qualificationChildProof.childInputDigest !== input.inputDigest
    )
      throw qualificationRefusal("qualification_child_stale");
    const parent = await assertExecutionChildParent(
      db,
      projectId,
      taskId,
      task.qualificationChildProof,
    );

    return {
      ...base,
      parent: task.qualificationChildProof,
      evidenceTarget: parent.taskAdmissionSnapshot?.evidenceTarget ?? null,
      evidenceSha: parent.taskAdmissionSnapshot?.evidenceSha ?? null,
    };
  }
  if (!input.currentQualificationId)
    throw qualificationRefusal("qualification_required");
  const [assessment] = await db
    .select()
    .from(taskQualifications)
    .where(
      and(
        eq(taskQualifications.id, input.currentQualificationId),
        eq(taskQualifications.taskId, taskId),
        eq(taskQualifications.projectId, projectId),
      ),
    );

  if (
    !assessment ||
    assessment.publicationState !== "accepted" ||
    assessment.value.decision !== "ready" ||
    assessment.inputRevision !== input.inputRevision ||
    assessment.inputDigest !== input.inputDigest ||
    assessment.revision !== input.currentQualificationRevision ||
    assessment.evidenceTarget !== input.target ||
    !assessment.evidenceSha
  )
    throw qualificationRefusal("qualification_stale");

  return {
    ...base,
    qualificationId: assessment.id,
    qualificationRevision: assessment.revision,
    evidenceTarget: assessment.evidenceTarget,
    evidenceSha: assessment.evidenceSha,
  };
}

export async function prepareTaskDeliveryAdmission(
  db: Db,
  args: {
    projectId: string;
    taskId: string;
    baseBranch?: string;
    baseCommit?: string;
    targetBranch?: string;
  },
): Promise<PreparedTaskDeliveryAdmission> {
  const snapshot = await readAdmission(db, args.projectId, args.taskId);

  if (snapshot.mode === "required") {
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, args.projectId));
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, args.taskId));

    if (!project || !task)
      throw qualificationRefusal("qualification_task_missing");
    if (
      (args.baseBranch !== undefined &&
        args.baseBranch !== snapshot.evidenceTarget) ||
      (args.targetBranch !== undefined &&
        args.targetBranch !== (task.targetBranch ?? snapshot.evidenceTarget))
    )
      throw qualificationRefusal("qualification_target_changed");
    const currentSha = await resolveBaseCommit({
      projectRepoPath: project.repoPath,
      baseRef: snapshot.evidenceTarget!,
    });

    if (currentSha !== snapshot.evidenceSha) {
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, args.taskId))
          .for("update");

        if (
          current?.currentQualificationId === snapshot.qualificationId &&
          current.qualificationInputRevision === snapshot.inputRevision
        )
          await requireTaskRequalification(tx, args.projectId, args.taskId);
      });
      throw qualificationRefusal("qualification_evidence_stale");
    }
    if (
      args.baseCommit !== undefined &&
      args.baseCommit !== snapshot.evidenceSha
    )
      throw qualificationRefusal("qualification_evidence_stale");
  }

  return {
    snapshot,
    baseCommit: snapshot.evidenceSha,
    apply: async (tx) => {
      if (snapshot.parent)
        await tx
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.id, snapshot.parent.parentRunId))
          .for("update");
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.id, args.taskId))
        .for("update");
      let current: TaskAdmissionSnapshot;

      try {
        current = await readAdmission(tx, args.projectId, args.taskId);
      } catch (error) {
        if (error instanceof MaisterError && error.code === "PRECONDITION")
          throw qualificationRefusal("qualification_stale", "CONFLICT");
        throw error;
      }

      if (retryDigest(current) !== retryDigest(snapshot))
        throw qualificationRefusal("qualification_stale", "CONFLICT");
      log.debug(
        {
          taskId: args.taskId,
          mode: snapshot.mode,
          inputRevision: snapshot.inputRevision,
          qualificationId: snapshot.qualificationId,
        },
        "task delivery admitted",
      );

      return snapshot;
    },
  };
}

export async function assertLegacyTriageOrCurrentQualification(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<void> {
  await readAdmission(db, projectId, taskId);
}

/** First dispatch only; a running execution retains its immutable admission after later task edits. */
export async function assertTaskAdmissionForDispatch(
  db: Db,
  runId: string,
): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (
    !run?.taskAdmissionSnapshot ||
    run.taskAdmissionCheckedAt ||
    !run.taskId ||
    !run.projectId
  )
    return;
  let prepared: PreparedTaskDeliveryAdmission;

  try {
    prepared = await prepareTaskDeliveryAdmission(db, {
      projectId: run.projectId,
      taskId: run.taskId,
    });
  } catch (error) {
    if (
      error instanceof MaisterError &&
      [
        "qualification_required",
        "qualification_stale",
        "qualification_evidence_stale",
      ].includes(String(error.details?.reason))
    )
      throw qualificationRefusal("qualification_stale");
    throw error;
  }
  if (retryDigest(prepared.snapshot) !== retryDigest(run.taskAdmissionSnapshot))
    throw qualificationRefusal("qualification_stale");
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");

    if (!current || current.taskAdmissionCheckedAt) return;
    await prepared.apply(tx);
    await tx
      .update(runs)
      .set({ taskAdmissionCheckedAt: new Date() })
      .where(eq(runs.id, runId));
  });
}

export function parentAdmissionDigest(
  parent: typeof runs.$inferSelect,
): string {
  return retryDigest(
    parent.taskAdmissionSnapshot ?? {
      version: 1,
      mode: "legacy",
      runId: parent.id,
      taskId: parent.taskId,
    },
  );
}

async function assertExecutionChildParent(
  db: Db,
  projectId: string,
  childTaskId: string,
  proof: TaskExecutionChildProof,
): Promise<typeof runs.$inferSelect> {
  const [parent] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, proof.parentRunId), eq(runs.projectId, projectId)));

  if (
    !parent ||
    parent.agentKind === "operational" ||
    AGENT_EXECUTION_STATUS[parent.status] !== "active" ||
    parentAdmissionDigest(parent) !== proof.parentAdmissionDigest ||
    parent.taskId !== proof.parentTaskId
  )
    throw qualificationRefusal("qualification_parent_unavailable");
  if (!parent.taskAdmissionSnapshot && parent.taskId) {
    const [task] = await db
      .select({ mode: tasks.qualificationMode })
      .from(tasks)
      .where(eq(tasks.id, parent.taskId));

    if (task?.mode !== "legacy" || !proof.parentLegacy)
      throw qualificationRefusal("qualification_parent_required");
  }
  if (proof.relationId) {
    const relation = await db.execute(
      sql`SELECT id FROM task_relations WHERE id=${proof.relationId} AND from_task_id=${proof.parentTaskId} AND to_task_id=${childTaskId} AND kind='parent_of'`,
    );

    if (!relation.rows.length)
      throw qualificationRefusal("qualification_child_relation_missing");
  } else if (proof.parentTaskId)
    throw qualificationRefusal("qualification_child_relation_missing");

  return parent;
}

/** Bound-parent callers invoke this before creating any carrier task. */
export async function assertExecutionParentAdmission(
  db: Db,
  projectId: string,
  parentRunId: string,
): Promise<typeof runs.$inferSelect> {
  const [parent] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, parentRunId), eq(runs.projectId, projectId)))
    .for("update");

  if (
    !parent ||
    parent.agentKind === "operational" ||
    AGENT_EXECUTION_STATUS[parent.status] !== "active"
  )
    throw qualificationRefusal("qualification_parent_unavailable");
  if (parent.taskId) {
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, parent.taskId))
      .for("update");

    if (
      !task ||
      (task.qualificationMode !== "legacy" && !parent.taskAdmissionSnapshot)
    )
      throw qualificationRefusal("qualification_parent_required");
  }

  return parent;
}

export async function establishExecutionChildAdmission(
  db: Db,
  input: {
    projectId: string;
    parentRunId: string;
    childTaskId: string;
    planRevision: string;
  },
): Promise<void> {
  const parent = await assertExecutionParentAdmission(
    db,
    input.projectId,
    input.parentRunId,
  );

  if (parent.taskAdmissionSnapshot?.evidenceTarget) {
    const delivery = await db.execute<{ target_branch: string }>(
      sql`SELECT target_branch FROM workspaces WHERE run_id=${parent.id} LIMIT 1`,
    );

    await db
      .update(tasks)
      .set({
        baseBranch: parent.taskAdmissionSnapshot.evidenceTarget,
        targetBranch:
          delivery.rows[0]?.target_branch ??
          parent.taskAdmissionSnapshot.evidenceTarget,
      })
      .where(eq(tasks.id, input.childTaskId));
  }
  const current = await loadTaskQualificationInput(
    db,
    input.projectId,
    input.childTaskId,
  );
  const relation = parent.taskId
    ? await db.execute<{ id: string }>(
        sql`SELECT id FROM task_relations WHERE from_task_id=${parent.taskId} AND to_task_id=${input.childTaskId} AND kind='parent_of' LIMIT 1`,
      )
    : null;

  if (parent.taskId && !relation?.rows[0])
    throw qualificationRefusal("qualification_child_relation_missing");
  const proof: TaskExecutionChildProof = {
    version: 1,
    parentRunId: parent.id,
    parentTaskId: parent.taskId,
    parentAdmissionDigest: parentAdmissionDigest(parent),
    parentLegacy:
      parent.taskAdmissionSnapshot?.mode === "legacy" ||
      !parent.taskAdmissionSnapshot,
    planRevision: input.planRevision,
    childInputDigest: current.inputDigest,
    relationId: relation?.rows[0]?.id ?? null,
  };

  await db
    .update(tasks)
    .set({
      qualificationMode: "execution_child",
      qualificationChildProof: proof,
    })
    .where(
      and(
        eq(tasks.id, input.childTaskId),
        eq(tasks.projectId, input.projectId),
      ),
    );
}
