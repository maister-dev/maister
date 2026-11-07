import "server-only";

import type {
  HumanAssessmentDraft,
  HumanAssessmentWrite,
} from "./human-assessment-schema";
import type {
  TaskQualificationReceipt,
  TaskQualificationInput,
} from "./qualification";
import type { Db } from "@/lib/execution-host/db";
import type { TaskQualificationValue } from "./qualification-types";

import { posix } from "node:path";

import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import pino from "pino";

import {
  loadTaskQualificationInput,
  prepareTaskQualification,
  taskQualificationReceipt,
} from "./qualification";
import { assertTaskLaunchUserAuthority } from "./launch-authority";
import { lockTaskLaunchReservation } from "./launch-locks";
import {
  humanAssessmentWriteSchema,
  humanAssessmentIssues,
  humanAssessmentValue,
} from "./human-assessment-schema";

import { projects, runs, tasks, taskQualifications } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { resolveBaseCommit, listTree, repoRelPathSchema } from "@/lib/worktree";

const log = pino({
  name: "human-assessment",
  level: process.env.LOG_LEVEL ?? "info",
});

export type HumanAssessmentScope = Readonly<{
  projectId: string;
  taskId: string;
  userId: string;
}>;

function assessmentContextToken(input: TaskQualificationInput): string {
  return retryDigest({
    version: 1,
    kind: "human_assessment_context",
    inputDigest: input.inputDigest,
    inputRevision: input.inputRevision,
    qualificationRevision: input.currentQualificationRevision,
  });
}

function repositoryContextToken(contextToken: string, sha: string): string {
  return retryDigest({ version: 1, contextToken, sha });
}

/** Read-only choices are project-scoped; repository browsing retains its separate permission. */
export async function getHumanTaskAssessmentDraft(
  db: Db,
  scope: HumanAssessmentScope,
  options: Readonly<{ search?: string; repository?: boolean }> = {},
): Promise<HumanAssessmentDraft> {
  await assertTaskLaunchUserAuthority(db, scope.projectId, scope.userId, [
    "editTask",
  ]);
  const input = await loadTaskQualificationInput(
    db,
    scope.projectId,
    scope.taskId,
  );
  const [project] = await db
    .select({ key: projects.taskKey, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, scope.projectId));

  if (!project)
    throw new MaisterError("PRECONDITION", "Assessment project is unavailable");
  const search = options.search?.trim();
  const taskRows = await db
    .select({ id: tasks.id, number: tasks.number, title: tasks.title })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, scope.projectId),
        ...(search
          ? [
              or(
                ilike(tasks.title, `%${search}%`),
                sql`${tasks.number}::text ILIKE ${`%${search}%`}`,
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(tasks.updatedAt), asc(tasks.id))
    .limit(25);
  const runRows = await db
    .select({ id: runs.id, title: tasks.title, agentId: runs.agentId })
    .from(runs)
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(runs.projectId, scope.projectId),
        ...(search
          ? [
              or(
                ilike(tasks.title, `%${search}%`),
                ilike(runs.agentId, `%${search}%`),
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(runs.startedAt), asc(runs.id))
    .limit(25);
  const contextToken = assessmentContextToken(input);
  let repository: HumanAssessmentDraft["repository"];

  if (options.repository) {
    await assertTaskLaunchUserAuthority(db, scope.projectId, scope.userId, [
      "editTask",
      "readRepoFiles",
    ]);
    const sha = await resolveBaseCommit({
      projectRepoPath: project.repoPath,
      baseRef: input.target,
    });

    repository = { ref: sha, token: repositoryContextToken(contextToken, sha) };
  }

  return {
    contextToken,
    expectedInputRevision: input.inputRevision,
    expectedQualificationRevision: input.currentQualificationRevision,
    tasks: taskRows.map((task) => ({
      id: task.id,
      label: `${project.key}-${task.number} · ${task.title}`,
    })),
    runs: runRows.map((run) => ({
      id: run.id,
      label: `${run.title ?? run.agentId ?? "Run"} · ${run.id.slice(0, 8)}`,
    })),
    ...(repository ? { repository } : {}),
  };
}

/** Human authoring stays separate from the machine result and launch authority. */
export async function recordHumanTaskAssessment(
  db: Db,
  scope: HumanAssessmentScope,
  rawRequest: unknown,
): Promise<TaskQualificationReceipt> {
  await assertTaskLaunchUserAuthority(db, scope.projectId, scope.userId, [
    "editTask",
  ]);
  const parsed = humanAssessmentWriteSchema.safeParse(rawRequest);

  if (!parsed.success) {
    const issues = humanAssessmentIssues(parsed.error);

    log.warn(
      { taskId: scope.taskId, issues },
      "human-assessment-validation-refused",
    );
    throw new MaisterError(
      "CONFIG",
      "Review the highlighted assessment fields",
      {
        details: { reason: "human_assessment_invalid", issues },
      },
    );
  }
  const request = parsed.data;
  const needsRepository = request.evidence.some((item) => item.kind === "file");
  const actions = needsRepository
    ? (["editTask", "readRepoFiles"] as const)
    : (["editTask"] as const);

  await assertTaskLaunchUserAuthority(
    db,
    scope.projectId,
    scope.userId,
    actions,
  );
  const requestDigest = retryDigest({
    version: 1,
    kind: "human_authoring",
    projectId: scope.projectId,
    taskId: scope.taskId,
    userId: scope.userId,
    request,
  });

  try {
    const replay = await findHumanAssessmentReplay(
      db,
      scope,
      request,
      requestDigest,
    );

    if (replay) return replay;
    const input = await loadTaskQualificationInput(
      db,
      scope.projectId,
      scope.taskId,
    );

    assertHumanAssessmentContext(input, request);
    const [project] = await db
      .select({ repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, scope.projectId));

    if (!project)
      throw new MaisterError(
        "PRECONDITION",
        "Assessment project is unavailable",
      );
    const evidenceSha = needsRepository
      ? await resolveBaseCommit({
          projectRepoPath: project.repoPath,
          baseRef: input.target,
        })
      : null;

    if (
      evidenceSha &&
      request.repositoryToken !==
        repositoryContextToken(request.contextToken, evidenceSha)
    )
      throw staleHumanAssessment();
    const references: TaskQualificationValue["evidenceRefs"] = [];

    for (const [index, selection] of request.evidence.entries()) {
      const id = `evidence-${index + 1}`;

      if (selection.kind === "file") {
        if (
          !repoRelPathSchema.safeParse(selection.path).success ||
          !evidenceSha
        )
          throw unavailableEvidence(index);
        const parent = posix.dirname(selection.path);
        const tree = await listTree({
          repo: project.repoPath,
          ref: evidenceSha,
          dir: parent === "." ? "" : parent,
        });

        if (
          !tree?.entries.some(
            (entry) =>
              entry.type === "file" &&
              entry.name === posix.basename(selection.path),
          )
        )
          throw unavailableEvidence(index);
        references.push({
          id,
          kind: "repository",
          reference: `git:${evidenceSha}:${selection.path}`,
        });
      } else if (selection.kind === "task") {
        const [source] = await db
          .select({ id: tasks.id, revision: tasks.revision })
          .from(tasks)
          .where(
            and(
              eq(tasks.id, selection.taskId),
              eq(tasks.projectId, scope.projectId),
            ),
          );

        if (!source) throw unavailableEvidence(index);
        references.push({
          id,
          kind: "task",
          reference: `task:${source.id}@${source.revision}`,
        });
      } else {
        const [source] = await db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, selection.runId),
              eq(runs.projectId, scope.projectId),
            ),
          );

        if (!source) throw unavailableEvidence(index);
        references.push({ id, kind: "run", reference: `run:${source.id}` });
      }
    }
    const prepared = await prepareTaskQualification(db, {
      projectId: scope.projectId,
      taskId: scope.taskId,
      author: { kind: "user", identity: scope.userId, userId: scope.userId },
      request: {
        requestKey: request.requestKey,
        expectedInputRevision: request.expectedInputRevision,
        expectedQualificationRevision: request.expectedQualificationRevision,
        qualification: humanAssessmentValue(request, references),
      },
      humanAuthoring: { requestDigest, evidenceSha },
    });

    return await db.transaction(async (tx) => {
      await lockTaskLaunchReservation(tx, scope.taskId);
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(tasks.id, scope.taskId), eq(tasks.projectId, scope.projectId)),
        )
        .for("update");
      await assertTaskLaunchUserAuthority(
        tx,
        scope.projectId,
        scope.userId,
        actions,
      );
      const repeated = await findHumanAssessmentReplay(
        tx,
        scope,
        request,
        requestDigest,
      );

      if (repeated) return repeated;
      assertHumanAssessmentContext(
        await loadTaskQualificationInput(tx, scope.projectId, scope.taskId),
        request,
      );
      const receipt = await prepared.apply(tx);

      log.info(
        {
          taskId: scope.taskId,
          qualificationId: receipt.qualificationId,
          authorKind: "user",
          referenceKinds: references.map((item) => item.kind),
          referenceCount: references.length,
          decision: receipt.decision,
        },
        "human-assessment-recorded",
      );

      return receipt;
    });
  } catch (error) {
    if (
      !isMaisterError(error) ||
      ![
        "qualification_stale",
        "human_assessment_evidence_unavailable",
      ].includes(String(error.details?.reason))
    )
      throw error;

    // A same-key winner can commit between the initial replay read and reference resolution.
    return db.transaction(async (tx) => {
      await lockTaskLaunchReservation(tx, scope.taskId);
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(tasks.id, scope.taskId), eq(tasks.projectId, scope.projectId)),
        )
        .for("update");
      await assertTaskLaunchUserAuthority(
        tx,
        scope.projectId,
        scope.userId,
        actions,
      );
      const repeated = await findHumanAssessmentReplay(
        tx,
        scope,
        request,
        requestDigest,
      );

      if (repeated) return repeated;
      throw error;
    });
  }
}

function staleHumanAssessment(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "The task, assessment or repository changed; reload the assessment",
    { details: { reason: "qualification_stale" } },
  );
}

function unavailableEvidence(index: number): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Selected evidence is unavailable in this project",
    {
      details: {
        reason: "human_assessment_evidence_unavailable",
        issues: [{ path: `evidence.${index}`, key: "evidence" }],
      },
    },
  );
}

function assertHumanAssessmentContext(
  input: TaskQualificationInput,
  request: HumanAssessmentWrite,
): void {
  if (
    assessmentContextToken(input) !== request.contextToken ||
    input.inputRevision !== request.expectedInputRevision ||
    input.currentQualificationRevision !== request.expectedQualificationRevision
  )
    throw staleHumanAssessment();
}

async function findHumanAssessmentReplay(
  db: Db,
  scope: HumanAssessmentScope,
  request: HumanAssessmentWrite,
  requestDigest: string,
): Promise<TaskQualificationReceipt | null> {
  const [existing] = await db
    .select()
    .from(taskQualifications)
    .where(
      and(
        eq(taskQualifications.projectId, scope.projectId),
        eq(taskQualifications.taskId, scope.taskId),
        eq(taskQualifications.requestKey, request.requestKey),
      ),
    )
    .limit(1);

  if (!existing) return null;
  if (
    existing.authorKind !== "user" ||
    existing.authorIdentity !== scope.userId ||
    existing.payloadDigest !== requestDigest
  )
    throw new MaisterError(
      "CONFLICT",
      "This assessment key belongs to another original request",
      { details: { reason: "qualification_request_conflict" } },
    );
  log.info(
    { taskId: scope.taskId, qualificationId: existing.id, authorKind: "user" },
    "human-assessment-replayed",
  );

  return taskQualificationReceipt(existing);
}
