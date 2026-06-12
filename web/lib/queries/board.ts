import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { BoardColumn, CrashAction } from "@/lib/board";
import type { RunStatus, StepRun } from "@/lib/db/schema";
import type { ReadinessState } from "@/lib/flows/graph/readiness-core";
import type { HitlOption } from "@/lib/queries/hitl";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { crashActionFor, deriveStage } from "@/lib/board";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { extractOptions } from "@/lib/queries/hitl";
import {
  lifecycleActionsForWorkspace,
  type WorkbenchLifecycleAction,
} from "@/lib/queries/portfolio";
import { computeReadinessByRun } from "@/lib/queries/readiness-batch";
import { runnerAgentFromFields } from "@/lib/queries/runner-agent";
import { getOpenRelationBlockers } from "@/lib/social/relations";

const {
  flows,
  hitlRequests,
  nodeAttempts,
  projects,
  runs,
  stepRuns,
  tasks,
  users,
  workspaces,
} = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export type BoardAgent = AdapterId | "dev";
export type CardStatus =
  | "running"
  | "needs"
  | "queued"
  | "done"
  | "crashed"
  | "humanworking";
export type CardPriority = "high" | "med" | "low";

export interface SpineSegment {
  state: "done" | "now" | "skip" | "todo";
}

export interface BacklogCard {
  taskId: string;
  number: number;
  keyRef: string;
  title: string;
  prompt: string;
  flowRef: string;
  priority: CardPriority;
  runCount: number;
  // ADR-078 D5: open relation blockers — non-empty disables Launch and
  // renders the reason chip with the blocker KEY-Ns.
  blockedBy: Array<{ key: string; number: number }>;
}

export interface FlightCard {
  taskId: string;
  number: number;
  keyRef: string;
  runCount: number;
  runStatus: RunStatus;
  runId: string;
  branch: string;
  agent: BoardAgent;
  status: CardStatus;
  stepLabel: string;
  stepBody: string;
  spine: SpineSegment[];
  time: string;
  plus: number | null;
  minus: number | null;
  // M11a: the latest run has at least one Reworked node attempt (review-driven
  // rework loop in flight). Minimal hint; the full timeline is M11b.
  reworking: boolean;
  // M11b (ADR-030): for a `humanworking` card, the takeover owner
  // (`users.name ?? users.email`). Null on every non-takeover card.
  owner: string | null;
  // M11c (ADR-032) Phase 4.3: the latest run had a node attempt whose
  // enforcement_snapshot recorded a `refused` verdict (a strict intent the
  // resolved agent could not honor at launch). Links to the run-detail panel.
  refused: boolean;
  // M19: the recover/discard affordance for a Crashed flow run. DTO-projected
  // from `acpSessionId` presence (`recover` if a checkpoint survives, else
  // `discard`); null on every non-Crashed card. The raw session id is NEVER
  // surfaced to the client.
  crashAction: CrashAction | null;
  lifecycleActions: WorkbenchLifecycleAction[];
  // T15 (M15): unified readiness summary badge, replacing the three separate
  // booleans (evidenceStale, mergeBlocked, externalGatePending). Computed over
  // the same bulk-fetched gate_results + artifact_instances + node_attempts rows
  // using readiness-core.ts (SSOT shared with assertEvidenceReady,
  // getRunReadiness) — no per-run getRunReadiness call, no N+1.
  // State = "ready" | "blocked" | "stale" | "failed" | "waiting" | "overridden".
  // Only rendered when readiness !== "ready" AND status !== "done".
  // Done cards always read "ready" (mirrors the old done-zeroing).
  readiness: ReadinessState;
  // M18 (T4.4): a flow run at `Review` whose unified readiness verdict is
  // "ready" — the operator can promote it. Done cards read false.
  readyToPromote: boolean;
  // M18 (T4.4): the pre-seeded PR number for a `pull_request`-mode run (display
  // only); null when no PR has been recorded.
  prNumber: number | null;
  // M17 P4: HITL fields, populated only for NeedsInput/NeedsInputIdle cards
  // with a pending (respondedAt IS NULL) hitl_requests row. All null/[] on
  // every non-needs card or when no pending request exists.
  hitlRequestId: string | null;
  hitlKind: "permission" | "form" | "human" | null;
  hitlOptions: HitlOption[];
  hitlSchema: unknown | null;
  criticality: "low" | "medium" | "high" | "critical" | null;
  blockedBy: Array<{ key: string; number: number }>;
}

export interface BoardColumnData {
  column: BoardColumn;
  backlog: BacklogCard[];
  flight: FlightCard[];
  total: number;
}

export interface BoardData {
  columns: Record<BoardColumn, BoardColumnData>;
  totalTasks: number;
  inProd: number;
  backlog: number;
  merged7d: number;
}

const SPINE_LENGTH = 7;

function relativeTime(from: Date, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - from.getTime()) / 1000),
  );

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);

  return `${days}d`;
}

function runStatusToCard(status: RunStatus): CardStatus {
  if (status === "HumanWorking") return "humanworking";
  if (status === "NeedsInput" || status === "NeedsInputIdle") return "needs";
  if (status === "Pending") return "queued";
  if (status === "Done") return "done";
  if (status === "Crashed") return "crashed";

  return "running";
}

function stepRunStatusToSegment(
  status: StepRun["status"],
): SpineSegment["state"] {
  if (status === "Succeeded") return "done";
  if (status === "Skipped") return "skip";
  if (status === "Running" || status === "NeedsInput") return "now";

  return "todo";
}

function buildSpine(steps: StepRun[]): SpineSegment[] {
  const ordered = [...steps].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  const segments: SpineSegment[] = ordered
    .slice(0, SPINE_LENGTH)
    .map((step) => ({ state: stepRunStatusToSegment(step.status) }));

  while (segments.length < SPINE_LENGTH) {
    segments.push({ state: "todo" });
  }

  return segments;
}

function priorityFor(index: number): CardPriority {
  if (index === 0) return "high";
  if (index <= 2) return "med";

  return "low";
}

function emptyColumn(column: BoardColumn): BoardColumnData {
  return { column, backlog: [], flight: [], total: 0 };
}

export async function getBoardData(projectId: string): Promise<BoardData> {
  const now = new Date();
  const client = db();

  const taskRows = await client
    .select({
      taskId: tasks.id,
      number: tasks.number,
      title: tasks.title,
      prompt: tasks.prompt,
      status: tasks.status,
      stage: tasks.stage,
      createdAt: tasks.createdAt,
      flowRef: flows.flowRefId,
    })
    .from(tasks)
    .innerJoin(flows, eq(flows.id, tasks.flowId))
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(tasks.createdAt));

  const columns: Record<BoardColumn, BoardColumnData> = {
    Backlog: emptyColumn("Backlog"),
    Prepare: emptyColumn("Prepare"),
    InProduction: emptyColumn("InProduction"),
    OnReview: emptyColumn("OnReview"),
    InDelivery: emptyColumn("InDelivery"),
    Crashed: emptyColumn("Crashed"),
    Done: emptyColumn("Done"),
  };

  if (taskRows.length === 0) {
    return {
      columns,
      totalTasks: 0,
      inProd: 0,
      backlog: 0,
      merged7d: 0,
    };
  }

  const taskIds = taskRows.map((t) => t.taskId);

  const [projectKeyRow] = await client
    .select({ taskKey: projects.taskKey })
    .from(projects)
    .where(eq(projects.id, projectId));
  const projectTaskKey = projectKeyRow?.taskKey ?? "";
  const openBlockers = await getOpenRelationBlockers(taskIds, client);

  const runCountRows = await client
    .select({
      taskId: runs.taskId,
      runId: runs.id,
    })
    .from(runs)
    .where(and(eq(runs.runKind, "flow"), inArray(runs.taskId, taskIds)));
  const runCountByTask = new Map<string, number>();

  for (const row of runCountRows) {
    if (!row.taskId) {
      continue;
    }

    runCountByTask.set(row.taskId, (runCountByTask.get(row.taskId) ?? 0) + 1);
  }

  const runRows = await client
    .select({
      runId: runs.id,
      taskId: runs.taskId,
      status: runs.status,
      acpSessionId: runs.acpSessionId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      capabilityAgent: runs.capabilityAgent,
      runnerSnapshot: runs.runnerSnapshot,
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      archivedBranch: workspaces.archivedBranch,
      removedAt: workspaces.removedAt,
      prNumber: workspaces.prNumber,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(and(eq(runs.runKind, "flow"), inArray(runs.taskId, taskIds)))
    .orderBy(desc(runs.startedAt));

  const latestRunByTask = new Map<string, (typeof runRows)[number]>();

  for (const row of runRows) {
    if (!row.taskId) {
      continue;
    }

    if (!latestRunByTask.has(row.taskId)) {
      latestRunByTask.set(row.taskId, row);
    }
  }

  const latestRunIds = [...latestRunByTask.values()].map((r) => r.runId);
  const stepsByRun = new Map<string, StepRun[]>();

  if (latestRunIds.length > 0) {
    const stepRows = await client
      .select()
      .from(stepRuns)
      .where(inArray(stepRuns.runId, latestRunIds));

    for (const step of stepRows) {
      const list = stepsByRun.get(step.runId) ?? [];

      list.push(step);
      stepsByRun.set(step.runId, list);
    }
  }

  // M11a: which latest runs have a Reworked node attempt (rework loop in
  // flight). Cheap projection — just the runId of any Reworked row.
  const reworkingRunIds = new Set<string>();

  if (latestRunIds.length > 0) {
    const reworkedRows: Array<{ runId: string }> = await client
      .select({ runId: nodeAttempts.runId })
      .from(nodeAttempts)
      .where(
        and(
          inArray(nodeAttempts.runId, latestRunIds),
          eq(nodeAttempts.status, "Reworked"),
        ),
      );

    for (const r of reworkedRows) reworkingRunIds.add(r.runId);
  }

  // M11c (ADR-032): which latest runs carry a recorded `refused` enforcement
  // verdict on any node attempt (a strict intent refused at launch). Cheap
  // projection over the persisted enforcement_snapshot audit.
  const refusedRunIds = new Set<string>();

  if (latestRunIds.length > 0) {
    const snapshotRows = await client
      .select({
        runId: nodeAttempts.runId,
        enforcementSnapshot: nodeAttempts.enforcementSnapshot,
      })
      .from(nodeAttempts)
      .where(inArray(nodeAttempts.runId, latestRunIds));

    for (const r of snapshotRows) {
      if (r.enforcementSnapshot?.some((e) => e.verdict === "refused")) {
        refusedRunIds.add(r.runId);
      }
    }
  }

  // T15 (M15, ADR-048): the unified readiness state per latest run, replacing
  // the M12 evidenceStale/mergeBlocked + M16 externalGatePending booleans, via
  // the shared computeReadinessByRun (readiness-batch) — no per-run
  // getRunReadiness call, no N+1. A required def with no validity="current" row
  // contributes "blocked" (never "stale"); the "stale" state comes only from a
  // blocking gate with status="stale".
  const readinessByRun = await computeReadinessByRun(client, latestRunIds);

  // M17 P4: bulk HITL query — one query for all NeedsInput/NeedsInputIdle
  // latest runs. Map by runId. Never N+1 and never leaks acp/supervisor handles.
  const hitlByRun = new Map<
    string,
    {
      hitlRequestId: string;
      hitlKind: "permission" | "form" | "human";
      hitlSchema: unknown | null;
      hitlOptions: HitlOption[];
      criticality: "low" | "medium" | "high" | "critical" | null;
    }
  >();

  const needsRunIds: string[] = [];

  for (const row of latestRunByTask.values()) {
    if (row.status === "NeedsInput" || row.status === "NeedsInputIdle") {
      needsRunIds.push(row.runId);
    }
  }

  if (needsRunIds.length > 0) {
    const hitlRows = await client
      .select({
        id: hitlRequests.id,
        runId: hitlRequests.runId,
        kind: hitlRequests.kind,
        rawSchema: hitlRequests.schema,
        criticality: hitlRequests.criticality,
      })
      .from(hitlRequests)
      .where(
        and(
          inArray(hitlRequests.runId, needsRunIds),
          isNull(hitlRequests.respondedAt),
        ),
      )
      .orderBy(asc(hitlRequests.createdAt));

    for (const row of hitlRows) {
      if (hitlByRun.has(row.runId)) continue;
      hitlByRun.set(row.runId, {
        hitlRequestId: row.id,
        hitlKind: row.kind,
        // Permission schemas carry supervisor-internal handles — never expose to
        // the browser (mirrors the ext-API DTO guard). Options suffice for the UI.
        hitlSchema: row.kind === "permission" ? null : (row.rawSchema ?? null),
        hitlOptions: extractOptions(row.kind, row.rawSchema),
        criticality: row.criticality ?? null,
      });
    }
  }

  // M11b (ADR-030): the active takeover claim per latest run — owner + the
  // claim time (the takeover node_attempts.started_at). Drives the
  // `humanworking` card's "claimed by <owner>" badge and elapsed time. The
  // open takeover row is the un-ended human attempt carrying an owner.
  const takeoverByRun = new Map<string, { owner: string; claimedAt: Date }>();

  if (latestRunIds.length > 0) {
    const takeoverRows = await client
      .select({
        runId: nodeAttempts.runId,
        startedAt: nodeAttempts.startedAt,
        attempt: nodeAttempts.attempt,
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

    for (const r of takeoverRows) {
      if (takeoverByRun.has(r.runId)) continue;
      takeoverByRun.set(r.runId, {
        owner: r.ownerName ?? r.ownerEmail,
        claimedAt: r.startedAt,
      });
    }
  }

  let backlogPos = 0;
  let merged7d = 0;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  for (const task of taskRows) {
    const run = latestRunByTask.get(task.taskId) ?? null;
    const column = deriveStage({
      taskStatus: task.status,
      taskStage: task.stage,
      runStatus: run?.status ?? null,
      workspaceRemoved: run?.removedAt != null,
    });
    const bucket = columns[column];

    bucket.total += 1;

    if (run === null || column === "Backlog" || column === "Prepare") {
      bucket.backlog.push({
        taskId: task.taskId,
        number: task.number,
        keyRef: `${projectTaskKey}-${task.number}`,
        title: task.title,
        prompt: task.prompt,
        flowRef: task.flowRef,
        priority: priorityFor(backlogPos),
        runCount: runCountByTask.get(task.taskId) ?? 0,
        blockedBy: openBlockers.get(task.taskId) ?? [],
      });
      backlogPos += 1;
      continue;
    }

    const steps = stepsByRun.get(run.runId) ?? [];
    const current = steps.find(
      (s) => s.status === "Running" || s.status === "NeedsInput",
    );
    const cardStatus = runStatusToCard(run.status);
    const takeover =
      cardStatus === "humanworking"
        ? (takeoverByRun.get(run.runId) ?? null)
        : null;

    bucket.flight.push({
      taskId: task.taskId,
      number: task.number,
      keyRef: `${projectTaskKey}-${task.number}`,
      runCount: runCountByTask.get(task.taskId) ?? 0,
      runStatus: run.status,
      runId: run.runId,
      branch: run.branch,
      agent: takeover
        ? "dev"
        : runnerAgentFromFields({
            capabilityAgent: run.capabilityAgent,
            runnerSnapshot: run.runnerSnapshot,
            context: run.runId,
          }),
      status: cardStatus,
      stepLabel: current?.stepId ?? run.status.toLowerCase(),
      stepBody: current?.stepType ? `${current.stepType} step` : task.title,
      spine: buildSpine(steps),
      // Elapsed: a takeover card counts from the claim time; a done card from
      // its end time; everything else from the run start.
      time: takeover
        ? relativeTime(takeover.claimedAt, now)
        : cardStatus === "done" && run.endedAt
          ? relativeTime(run.endedAt, now)
          : relativeTime(run.startedAt, now),
      plus: null,
      minus: null,
      reworking: cardStatus !== "done" && reworkingRunIds.has(run.runId),
      owner: takeover?.owner ?? null,
      refused: refusedRunIds.has(run.runId),
      crashAction: crashActionFor({
        runKind: "flow",
        runStatus: run.status,
        acpSessionId: run.acpSessionId,
      }),
      lifecycleActions: lifecycleActionsForWorkspace({
        runKind: "flow",
        runStatus: run.status,
        dialogStatus: null,
        hasWorkspace: Boolean(run.workspaceId),
        removedAt: run.removedAt,
        archivedBranch: run.archivedBranch,
      }),
      // Done cards always read "ready" — terminal, no actionable readiness badge.
      readiness:
        cardStatus === "done"
          ? "ready"
          : (readinessByRun.get(run.runId) ?? "ready"),
      // M18 (T4.4): promotable = a non-done Review run whose unified readiness
      // verdict is "ready" (the M15 unification of the old !merge-blocked &&
      // !evidence-stale && !external-gate-pending check).
      readyToPromote:
        cardStatus !== "done" &&
        run.status === "Review" &&
        (readinessByRun.get(run.runId) ?? "ready") === "ready",
      prNumber: run.prNumber ?? null,
      blockedBy: openBlockers.get(task.taskId) ?? [],
      // M17 P4: HITL fields — only for needs-status cards with a pending request.
      ...(cardStatus === "needs"
        ? (() => {
            const hitl = hitlByRun.get(run.runId) ?? null;

            return {
              hitlRequestId: hitl?.hitlRequestId ?? null,
              hitlKind: hitl?.hitlKind ?? null,
              hitlOptions: hitl?.hitlOptions ?? [],
              hitlSchema: hitl?.hitlSchema ?? null,
              criticality: hitl?.criticality ?? null,
            };
          })()
        : {
            hitlRequestId: null,
            hitlKind: null,
            hitlOptions: [],
            hitlSchema: null,
            criticality: null,
          }),
    });

    if (
      run.status === "Done" &&
      run.endedAt &&
      now.getTime() - run.endedAt.getTime() <= SEVEN_DAYS_MS
    ) {
      merged7d += 1;
    }
  }

  return {
    columns,
    totalTasks: taskRows.length,
    inProd: columns.InProduction.total,
    backlog: columns.Backlog.total,
    merged7d,
  };
}
