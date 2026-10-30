import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskQualificationMode,
  TaskQualificationValue,
  TaskQualificationRouting,
} from "@/lib/tasks/qualification-types";

import { createHash } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import {
  projects,
  projectTokens,
  runs,
  taskQualifications,
  taskClarifications,
  tasks,
} from "@/lib/db/schema";
import { validateVerdictRefs } from "@/lib/services/triage";
import { recordTaskActivity, actorForUserId } from "@/lib/social/activity";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { tokenHasScope } from "@/lib/tokens/scopes";
import { resolveBaseCommit } from "@/lib/worktree";
import {
  taskQualificationWriteSchema,
  type TaskQualificationWrite,
} from "@/lib/tasks/qualification-schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "task-qualification",
  level: process.env.LOG_LEVEL ?? "info",
});

export type TaskQualificationInput = {
  taskId: string;
  projectId: string;
  mode: "legacy" | "required" | "execution_child";
  inputRevision: number;
  inputDigest: string;
  currentQualificationId: string | null;
  currentQualificationRevision: number | null;
  target: string;
};

export function effectiveTaskQualificationPolicy(project: {
  taskQualificationBaseline: TaskQualificationMode;
  taskQualificationOverride: TaskQualificationMode | null;
}): TaskQualificationMode {
  return project.taskQualificationOverride ?? project.taskQualificationBaseline;
}

/** Absence clears only the reviewed override; the creation baseline never changes. */
export async function applyProjectQualificationConfig(
  tx: Db,
  projectId: string,
  configuration: { task_qualification?: TaskQualificationMode },
): Promise<void> {
  const updated = await tx
    .update(projects)
    .set({
      taskQualificationOverride: configuration.task_qualification ?? null,
    })
    .where(eq(projects.id, projectId))
    .returning({ id: projects.id });

  if (!updated.length)
    throw new MaisterError(
      "PRECONDITION",
      "Project qualification policy owner is missing",
      { details: { reason: "qualification_project_missing", projectId } },
    );
  log.info(
    { projectId, mode: configuration.task_qualification ?? "baseline" },
    "project-qualification-config-applied",
  );
}

/** Caller owns the task lock when this snapshot participates in a write CAS. */
export async function loadTaskQualificationInput(
  tx: Db,
  projectId: string,
  taskId: string,
): Promise<TaskQualificationInput> {
  const [row] = await tx
    .select({ task: tasks, defaultTarget: projects.mainBranch })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "Task is missing from its qualification project",
      { details: { reason: "qualification_task_missing", projectId, taskId } },
    );
  const clarifications = await tx
    .select({
      id: taskClarifications.id,
      question: taskClarifications.question,
      status: taskClarifications.status,
      answer: taskClarifications.answer,
      answeredAt: taskClarifications.answeredAt,
      supersededAt: taskClarifications.supersededAt,
    })
    .from(taskClarifications)
    .where(
      and(
        eq(taskClarifications.taskId, taskId),
        eq(taskClarifications.blocking, true),
      ),
    )
    .orderBy(asc(taskClarifications.seq))
    .limit(1001);

  if (clarifications.length > 1000)
    throw new MaisterError(
      "PRECONDITION",
      "Qualification input exceeds the supported clarification bound",
      {
        details: {
          reason: "qualification_input_limit",
          projectId,
          taskId,
          maximum: 1000,
        },
      },
    );
  const target = row.task.baseBranch ?? row.defaultTarget;
  const inputDigest = createHash("sha256")
    .update(
      canonicalCommandJson({
        version: 1,
        projectId,
        taskId,
        inputRevision: row.task.qualificationInputRevision,
        title: row.task.title,
        prompt: row.task.prompt,
        statementRevision: row.task.statementRevision,
        sourceVersion: row.task.qualificationSourceVersion,
        target,
        deliveryTarget: row.task.targetBranch ?? row.defaultTarget,
        clarifications: clarifications.map((item) => ({
          ...item,
          answeredAt: item.answeredAt?.toISOString() ?? null,
          supersededAt: item.supersededAt?.toISOString() ?? null,
        })),
      }),
    )
    .digest("hex");

  return {
    taskId,
    projectId,
    mode: row.task.qualificationMode,
    inputRevision: row.task.qualificationInputRevision,
    inputDigest,
    currentQualificationId: row.task.currentQualificationId,
    currentQualificationRevision: row.task.currentQualificationRevision,
    target,
  };
}

/** Explicit requalification is a semantic change even when the statement text is identical. */
export async function requireTaskRequalification(
  tx: Db,
  projectId: string,
  taskId: string,
): Promise<void> {
  const rows = await tx
    .update(tasks)
    .set({
      qualificationMode: "required",
      qualificationChildProof: null,
      qualificationInputRevision: sql`${tasks.qualificationInputRevision} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .returning({ inputRevision: tasks.qualificationInputRevision });

  if (!rows.length)
    throw new MaisterError(
      "PRECONDITION",
      "Task is missing from its requalification project",
      { details: { reason: "qualification_task_missing", projectId, taskId } },
    );
  log.info(
    { projectId, taskId, inputRevision: rows[0].inputRevision },
    "task-requalification-requested",
  );
}

export type TaskQualificationAuthor =
  | { kind: "user"; identity: string; userId: string }
  | {
      kind: "project_token";
      identity: string;
      tokenId: string;
      userId: string | null;
    }
  | { kind: "agent_run"; runId: string; tokenId: string };
export type TaskQualificationReceipt = {
  qualificationId: string;
  inputRevision: number;
  qualificationRevision: number;
  publicationState: "candidate" | "accepted" | "rejected";
  decision: TaskQualificationValue["decision"];
  publicationReason: string | null;
};
export function taskQualificationReceipt(
  row: typeof taskQualifications.$inferSelect,
): TaskQualificationReceipt {
  return {
    qualificationId: row.id,
    inputRevision: row.inputRevision,
    qualificationRevision: row.revision,
    publicationState: row.publicationState,
    decision: row.value.decision,
    publicationReason: row.publicationReason,
  };
}
export type PreparedTaskQualification = {
  apply: (tx: Db) => Promise<TaskQualificationReceipt>;
};

/** Called after locking the source run and task; never reads an external authority. */
async function assertQualificationCredential(
  tx: Db,
  projectId: string,
  author: TaskQualificationAuthor,
  sourceAgentId: string | null | undefined,
): Promise<void> {
  if (author.kind !== "user") {
    const [token] = await tx
      .select()
      .from(projectTokens)
      .where(eq(projectTokens.id, author.tokenId))
      .for("update");

    if (
      !token ||
      token.revoked_at ||
      (token.expires_at && token.expires_at.getTime() <= Date.now()) ||
      token.project_id !== projectId ||
      !tokenHasScope(token.scopes, "tasks:triage") ||
      (author.kind === "agent_run" &&
        (token.token_kind !== "agent" ||
          token.name !== `agent-run:${author.runId}` ||
          token.agent_id !== sourceAgentId))
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "The qualification credential is no longer authorized",
        { details: { reason: "qualification_author_revoked" } },
      );
  }
}

/** Git resolution precedes the transaction. Authority and both freshness tokens are rechecked in apply. */
export async function prepareTaskQualification(
  db: Db,
  input: {
    projectId: string;
    taskId: string;
    author: TaskQualificationAuthor;
    request: TaskQualificationWrite;
  },
): Promise<PreparedTaskQualification> {
  const author = input.author;
  const parsed = taskQualificationWriteSchema.safeParse(input.request);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid structured task qualification", {
      details: { reason: "qualification_invalid", issues: parsed.error.issues },
    });
  const request = parsed.data;
  const payloadDigest = createHash("sha256")
    .update(
      canonicalCommandJson({
        request,
        author:
          author.kind === "agent_run"
            ? { kind: author.kind, runId: author.runId }
            : { kind: author.kind, identity: author.identity },
      }),
    )
    .digest("hex");
  const [existing] = await db
    .select()
    .from(taskQualifications)
    .where(
      and(
        eq(taskQualifications.projectId, input.projectId),
        eq(taskQualifications.taskId, input.taskId),
        eq(taskQualifications.inputRevision, request.expectedInputRevision),
        eq(taskQualifications.requestKey, request.requestKey),
      ),
    )
    .limit(1);

  if (existing && existing.payloadDigest !== payloadDigest)
    throw new MaisterError(
      "CONFLICT",
      "Qualification request key was reused with another payload",
      { details: { reason: "qualification_request_conflict" } },
    );
  const before = await loadTaskQualificationInput(
    db,
    input.projectId,
    input.taskId,
  );

  if (
    !existing &&
    request.baseBranch !== undefined &&
    request.baseBranch !== before.target
  )
    throw new MaisterError(
      "CONFLICT",
      "Change the task target before assessing its new revision",
      { details: { reason: "qualification_target_changed" } },
    );
  const sourceRun =
    author.kind === "agent_run"
      ? (await db.select().from(runs).where(eq(runs.id, author.runId)))[0]
      : null;
  const frozen = sourceRun?.taskQualificationSnapshot;

  if (
    author.kind === "agent_run" &&
    (!sourceRun ||
      sourceRun.projectId !== input.projectId ||
      sourceRun.taskId !== input.taskId ||
      frozen?.role !== "qualifier" ||
      (!existing && frozen.target !== before.target) ||
      !frozen.sha)
  )
    throw new MaisterError(
      "PRECONDITION",
      "A task assessment requires its bound qualifier evidence run",
      { details: { reason: "qualification_author_scope" } },
    );
  const [project] = await db
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, input.projectId));

  if (!project)
    throw new MaisterError("PRECONDITION", "Qualification project is missing");
  const evidenceSha = existing
    ? existing.evidenceSha
    : (frozen?.sha ??
      (request.qualification.decision === "ready"
        ? await resolveBaseCommit({
            projectRepoPath: project.repoPath,
            baseRef: before.target,
          })
        : null));

  return {
    apply: async (tx) => {
      const source =
        author.kind === "agent_run"
          ? (
              await tx
                .select()
                .from(runs)
                .where(eq(runs.id, author.runId))
                .for("update")
            )[0]
          : null;
      const sourceAgentId = source?.sourceAgentId ?? source?.agentId;

      if (author.kind === "agent_run" && !sourceAgentId)
        throw new MaisterError(
          "PRECONDITION",
          "Qualifier source identity is unavailable",
          { details: { reason: "qualification_author_identity_missing" } },
        );
      const [task] = await tx
        .select()
        .from(tasks)
        .where(
          and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)),
        )
        .for("update");

      if (!task)
        throw new MaisterError("PRECONDITION", "Qualification task is missing");
      if (
        author.kind === "agent_run" &&
        (!source ||
          source.status !== "Running" ||
          source.taskQualificationSnapshot?.role !== "qualifier" ||
          source.taskId !== task.id ||
          source.projectId !== input.projectId)
      )
        throw new MaisterError(
          "CONFLICT",
          "The qualifier run no longer owns an active assessment",
          { details: { reason: "qualification_author_inactive" } },
        );
      await assertQualificationCredential(
        tx,
        input.projectId,
        author,
        sourceAgentId,
      );
      const [replay] = await tx
        .select()
        .from(taskQualifications)
        .where(
          and(
            eq(taskQualifications.taskId, task.id),
            eq(taskQualifications.inputRevision, request.expectedInputRevision),
            eq(taskQualifications.requestKey, request.requestKey),
          ),
        )
        .limit(1);

      if (replay) {
        if (replay.payloadDigest !== payloadDigest)
          throw new MaisterError(
            "CONFLICT",
            "Qualification request key was reused with another payload",
            { details: { reason: "qualification_request_conflict" } },
          );

        return taskQualificationReceipt(replay);
      }
      const current = await loadTaskQualificationInput(
        tx,
        input.projectId,
        task.id,
      );

      if (author.kind === "agent_run" && current.mode === "legacy")
        throw new MaisterError(
          "PRECONDITION",
          "Explicitly opt this task into qualification before submitting an assessment",
          { details: { reason: "qualification_not_required" } },
        );
      if (
        current.inputRevision !== request.expectedInputRevision ||
        current.inputDigest !== before.inputDigest ||
        current.currentQualificationRevision !==
          request.expectedQualificationRevision
      )
        throw new MaisterError(
          "CONFLICT",
          "Task input or current qualification changed; reload and reassess",
          {
            details: {
              reason: "qualification_stale",
              inputRevision: current.inputRevision,
              qualificationRevision: current.currentQualificationRevision,
            },
          },
        );
      if (author.kind === "agent_run") {
        const [prior] = await tx
          .select({ id: taskQualifications.id })
          .from(taskQualifications)
          .where(
            and(
              eq(taskQualifications.taskId, task.id),
              eq(taskQualifications.originalRunId, author.runId),
              eq(taskQualifications.inputRevision, current.inputRevision),
            ),
          )
          .limit(1);

        if (prior)
          throw new MaisterError(
            "CONFLICT",
            "This run already submitted an assessment for this input revision",
            {
              details: {
                reason: "qualification_candidate_exists",
                qualificationId: prior.id,
              },
            },
          );
      }
      if (author.kind !== "agent_run" && current.mode !== "required") {
        await tx
          .update(tasks)
          .set({ qualificationMode: "required", qualificationChildProof: null })
          .where(eq(tasks.id, task.id));
      }
      const verdict = await validateVerdictRefs(
        input.projectId,
        {
          flowId: request.flowId ?? task.flowId,
          runnerId: request.runnerId ?? task.runnerId,
          baseBranch: request.baseBranch ?? task.baseBranch,
        },
        tx,
      );
      const routing: TaskQualificationRouting = {
        flowId: verdict.flowId ?? null,
        runnerId: verdict.runnerId ?? null,
        baseBranch: verdict.baseBranch ?? null,
        enqueue: request.enqueue ?? false,
        expected: {
          flowId: task.flowId,
          runnerId: task.runnerId,
          baseBranch: task.baseBranch,
        },
      };
      const [allocation] = await tx
        .update(tasks)
        .set({
          qualificationRevisionCounter: sql`${tasks.qualificationRevisionCounter} + 1`,
        })
        .where(eq(tasks.id, task.id))
        .returning({ revision: tasks.qualificationRevisionCounter });
      const agent = author.kind === "agent_run";
      const [assessment] = await tx
        .insert(taskQualifications)
        .values({
          projectId: input.projectId,
          taskId: task.id,
          revision: allocation.revision,
          inputRevision: current.inputRevision,
          inputDigest: current.inputDigest,
          requestKey: request.requestKey,
          payloadDigest,
          expectedQualificationRevision: request.expectedQualificationRevision,
          authorKind: author.kind,
          authorIdentity: agent ? sourceAgentId! : author.identity,
          authorTokenId: author.kind === "user" ? null : author.tokenId,
          authorUserId: agent ? null : author.userId,
          authorRunId: agent ? author.runId : null,
          originalRunId: agent ? author.runId : null,
          evidenceTarget: before.target,
          evidenceSha,
          value: request.qualification,
          routing,
          publicationState: agent ? "candidate" : "accepted",
          publishedAt: agent ? null : new Date(),
        })
        .returning();

      if (agent) {
        await emitDomainEvent({
          db: tx,
          kind: "task.qualification_changed",
          projectId: input.projectId,
          taskId: task.id,
          runId: author.runId,
          payload: {
            projectId: input.projectId,
            taskId: task.id,
            inputRevision: current.inputRevision,
            qualificationRevision: current.currentQualificationRevision,
          },
        });
      } else {
        const ready = assessment.value.decision === "ready";
        const enqueue = ready && routing.enqueue && routing.flowId !== null;

        await tx
          .update(tasks)
          .set({
            currentQualificationId: assessment.id,
            currentQualificationRevision: assessment.revision,
            triageStatus: ready ? "triaged" : "flagged",
            flowId: routing.flowId,
            runnerId: routing.runnerId,
            launchMode: enqueue ? "auto" : null,
            launchArmedAt: enqueue ? new Date() : null,
            queueClaimedAt: null,
          })
          .where(eq(tasks.id, task.id));
      }
      await recordTaskActivity(tx, {
        projectId: input.projectId,
        taskId: task.id,
        actor: agent
          ? { type: "agent", id: sourceAgentId! }
          : actorForUserId(author.userId),
        eventKind: "triage_set",
        payload: {
          qualificationId: assessment.id,
          qualificationRevision: assessment.revision,
          publicationState: assessment.publicationState,
          decision: assessment.value.decision,
        },
      });
      log.info(
        {
          taskId: task.id,
          qualificationId: assessment.id,
          revision: assessment.revision,
          inputRevision: current.inputRevision,
          state: assessment.publicationState,
          decision: assessment.value.decision,
        },
        "task-qualification-submitted",
      );

      return taskQualificationReceipt(assessment);
    },
  };
}
