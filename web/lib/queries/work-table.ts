import "server-only";

/**
 * The `/work` read model (ADR-169 · `STG-08`, `STG-09`).
 *
 * One batched pass over every task the reader can see, across projects, whether
 * or not it has ever launched a run. The board's batching, not its per-project
 * scope: every derived value is read set-at-a-time keyed on the ids already in
 * hand, so the statement count is a function of the SHAPE of the read model and
 * not of how many rows come back (`STG-08`, asserted by `IT-STG-08`).
 *
 * Scope is `getVisibleProjectIds` and nothing else (`STG-09`). The route's
 * project/stage filters narrow the returned set in memory rather than in SQL —
 * a filter is a view over the one comparable list, not a different query, and
 * that is also what keeps the statement count flat.
 */

import type { GlobalRole, RunStatus } from "@/lib/db/schema";
import type { ReadinessState } from "@/lib/flows/graph/readiness-core";
import type { PromotedKind, WorkProgress, WorkStage } from "@/lib/work/stage";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  buildFlightProgress,
  type ProgressNodeAttempt,
} from "@/lib/queries/board-progress";
import { computeReadinessByRun } from "@/lib/queries/readiness-batch";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";
import { queryTokensByTaskIds } from "@/lib/runs/cost-rollups";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { deriveWorkStage } from "@/lib/work/stage";

const {
  actorIdentities,
  assignments,
  flows,
  hitlRequests,
  nodeAttempts,
  projects,
  runs,
  tasks,
  users,
  workspaces,
} = schema;

const log = pino({
  name: "queries-work-table",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface WorkTableResult {
  rows: WorkTableRow[];
  /**
   * How many projects the reader can see at all. An empty `rows` means two very
   * different things — "you belong to nothing" and "nothing matched" — and the
   * page must be able to say which without asking a second query.
   */
  projectCount: number;
}

export interface WorkTableUser {
  id: string;
  role: GlobalRole;
}

/**
 * Who the row is parked on. `you` is the reader; `person` is a named someone
 * else; `anyone` is an open request nobody has been assigned. The distinction
 * comes from the HITL assignment's actor identity — there is no role concept in
 * the flow DSL to read one from.
 */
export interface WorkTableWaitingOn {
  kind: "you" | "person" | "anyone";
  name: string | null;
  since: Date;
}

export interface WorkTableBlocker {
  taskId: string;
  keyRef: string;
}

export interface WorkTableRow {
  taskId: string;
  number: number;
  keyRef: string;
  title: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  stage: WorkStage;
  blocked: boolean;
  promotedKind: PromotedKind | null;
  progress: WorkProgress | null;
  runId: string | null;
  runStatus: RunStatus | null;
  readiness: ReadinessState | null;
  waitingOn: WorkTableWaitingOn | null;
  blockers: WorkTableBlocker[];
  tokens: number;
  lastActivityAt: Date;
}

function progressOfSpine(
  spine: ReturnType<typeof buildFlightProgress>["spine"],
): WorkProgress | null {
  if (spine.length === 0) return null;

  return {
    done: spine.filter((segment) => segment.state === "done").length,
    total: spine.length,
  };
}

export async function getWorkTable(
  user: WorkTableUser,
): Promise<WorkTableResult> {
  const startedAt = Date.now();
  const client = getDb() as NodePgDatabase<typeof schema>;
  const projectIds = await getVisibleProjectIds(user.id, user.role, client);

  if (projectIds.length === 0) return { rows: [], projectCount: 0 };

  const projectRows = await client
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      taskKey: projects.taskKey,
    })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const projectById = new Map(projectRows.map((row) => [row.id, row]));

  // leftJoin on flows for the same reason the board does it: a flowless
  // simple-intent task is still work, and still belongs in the table.
  const taskRows = await client
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      stage: tasks.stage,
      triageStatus: tasks.triageStatus,
      createdAt: tasks.createdAt,
      flowManifest: flows.manifest,
    })
    .from(tasks)
    .leftJoin(flows, eq(flows.id, tasks.flowId))
    .where(inArray(tasks.projectId, projectIds));

  if (taskRows.length === 0) {
    return { rows: [], projectCount: projectIds.length };
  }

  const taskIds = taskRows.map((row) => row.taskId);
  const runRows = await client
    .select({
      runId: runs.id,
      taskId: runs.taskId,
      status: runs.status,
      runKind: runs.runKind,
      currentStepId: runs.currentStepId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      promotionState: workspaces.promotionState,
      removedAt: workspaces.removedAt,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(and(eq(runs.runKind, "flow"), inArray(runs.taskId, taskIds)))
    .orderBy(desc(runs.startedAt));

  const latestRunByTask = new Map<string, (typeof runRows)[number]>();

  for (const row of runRows) {
    if (!row.taskId || latestRunByTask.has(row.taskId)) continue;
    latestRunByTask.set(row.taskId, row);
  }

  const latestRunIds = [...latestRunByTask.values()].map((row) => row.runId);
  const attemptsByRun = new Map<string, ProgressNodeAttempt[]>();
  const latestAttemptAtByRun = new Map<string, Date>();
  const waitingByRun = new Map<string, WorkTableWaitingOn>();

  // The three run-keyed reads short-circuit together on an empty run set, the
  // same way computeReadinessByRun and getOpenRelationBlockers do — `inArray`
  // with an empty list is a Drizzle footgun, and a table of pre-flight tasks
  // should cost nothing extra.
  if (latestRunIds.length > 0) {
    const attemptRows = await client
      .select({
        attempt: nodeAttempts.attempt,
        nodeId: nodeAttempts.nodeId,
        runId: nodeAttempts.runId,
        startedAt: nodeAttempts.startedAt,
        status: nodeAttempts.status,
      })
      .from(nodeAttempts)
      .where(inArray(nodeAttempts.runId, latestRunIds));

    for (const attempt of attemptRows) {
      const list = attemptsByRun.get(attempt.runId) ?? [];

      list.push(attempt);
      attemptsByRun.set(attempt.runId, list);

      const seen = latestAttemptAtByRun.get(attempt.runId);

      if (!seen || attempt.startedAt > seen) {
        latestAttemptAtByRun.set(attempt.runId, attempt.startedAt);
      }
    }

    // The open, respondable HITL per run, with whoever it was assigned to. Same
    // open-request predicate as the cross-project inbox, so the table and the
    // inbox never disagree about what is waiting.
    const hitlRows = await client
      .select({
        runId: hitlRequests.runId,
        createdAt: hitlRequests.createdAt,
        assigneeUserId: actorIdentities.userId,
        assigneeLabel: actorIdentities.label,
      })
      .from(hitlRequests)
      .innerJoin(runs, eq(runs.id, hitlRequests.runId))
      .leftJoin(assignments, eq(assignments.hitlRequestId, hitlRequests.id))
      .leftJoin(
        actorIdentities,
        eq(actorIdentities.id, assignments.assigneeActorId),
      )
      .where(
        and(
          inArray(hitlRequests.runId, latestRunIds),
          isNull(hitlRequests.respondedAt),
          or(
            inArray(runs.status, ["NeedsInput", "NeedsInputIdle"]),
            and(
              eq(hitlRequests.kind, "agent_question"),
              eq(hitlRequests.activationState, "active"),
              isNull(hitlRequests.supersededAt),
            ),
          ),
        ),
      )
      .orderBy(asc(hitlRequests.createdAt));

    for (const row of hitlRows) {
      if (waitingByRun.has(row.runId)) continue;
      waitingByRun.set(row.runId, {
        kind:
          row.assigneeUserId === null
            ? "anyone"
            : row.assigneeUserId === user.id
              ? "you"
              : "person",
        name: row.assigneeLabel,
        since: row.createdAt,
      });
    }

    // An open takeover claim (ADR-030) parks the run on a named person even
    // though no HITL row is outstanding.
    const takeoverRows = await client
      .select({
        runId: nodeAttempts.runId,
        startedAt: nodeAttempts.startedAt,
        attempt: nodeAttempts.attempt,
        ownerUserId: nodeAttempts.ownerUserId,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(nodeAttempts)
      .innerJoin(users, eq(users.id, nodeAttempts.ownerUserId))
      .where(
        and(
          inArray(nodeAttempts.runId, latestRunIds),
          eq(nodeAttempts.nodeType, "human"),
          isNull(nodeAttempts.endedAt),
        ),
      )
      .orderBy(desc(nodeAttempts.attempt));

    for (const row of takeoverRows) {
      if (waitingByRun.has(row.runId)) continue;
      waitingByRun.set(row.runId, {
        kind: row.ownerUserId === user.id ? "you" : "person",
        name: row.ownerName ?? row.ownerEmail,
        since: row.startedAt,
      });
    }
  }

  const readinessByRun = await computeReadinessByRun(client, latestRunIds);
  const tokensByTask = await queryTokensByTaskIds(taskIds, { client });
  const blockersByTask = await getOpenRelationBlockers(taskIds, client);

  const rows: WorkTableRow[] = [];

  for (const task of taskRows) {
    const project = projectById.get(task.projectId);

    if (!project) continue;

    const run = latestRunByTask.get(task.taskId) ?? null;
    const spine = run
      ? buildFlightProgress({
          currentStepId: run.currentStepId,
          manifest: task.flowManifest,
          nodeAttempts: attemptsByRun.get(run.runId) ?? [],
          runStatus: run.status,
        }).spine
      : [];
    const blockers = blockersByTask.get(task.taskId) ?? [];
    const derived = deriveWorkStage({
      taskStatus: task.status,
      taskStage: task.stage,
      triageStatus: task.triageStatus,
      runStatus: run?.status ?? null,
      runKind: run?.runKind ?? null,
      promotionState: run?.promotionState ?? null,
      workspaceRemoved: run?.removedAt != null,
      blockingRelationCount: blockers.length,
      progress: progressOfSpine(spine),
    });

    rows.push({
      taskId: task.taskId,
      number: task.number,
      keyRef: `${project.taskKey}-${task.number}`,
      title: task.title,
      projectId: project.id,
      projectSlug: project.slug,
      projectName: project.name,
      stage: derived.stage,
      blocked: derived.blocked,
      promotedKind: derived.promotedKind,
      progress: derived.progress,
      runId: run?.runId ?? null,
      runStatus: run?.status ?? null,
      readiness: run ? (readinessByRun.get(run.runId) ?? null) : null,
      waitingOn: run ? (waitingByRun.get(run.runId) ?? null) : null,
      blockers: blockers.map((blocker) => ({
        taskId: blocker.taskId,
        keyRef: `${blocker.key}-${blocker.number}`,
      })),
      tokens: tokensByTask.get(task.taskId) ?? 0,
      lastActivityAt:
        (run && latestAttemptAtByRun.get(run.runId)) ??
        run?.endedAt ??
        run?.startedAt ??
        task.createdAt,
    });
  }

  rows.sort(
    (a, b) =>
      b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
      a.keyRef.localeCompare(b.keyRef),
  );

  log.debug(
    {
      userId: user.id,
      projectCount: projectIds.length,
      rowCount: rows.length,
      elapsedMs: Date.now() - startedAt,
    },
    "work table",
  );

  return { rows, projectCount: projectIds.length };
}
