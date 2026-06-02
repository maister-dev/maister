import "server-only";

import type { BoardColumn, CrashAction } from "@/lib/board";
import type { RunStatus, StepRun } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { crashActionFor, deriveStage } from "@/lib/board";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const {
  artifactInstances,
  executors,
  flows,
  gateResults,
  nodeAttempts,
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

export type BoardAgent = "claude" | "codex" | "dev";
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
  title: string;
  prompt: string;
  flowRef: string;
  priority: CardPriority;
}

export interface FlightCard {
  taskId: string;
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
  // M12 (ADR-037) Phase 7: the latest run has ≥1 stale artifact (evidence
  // invalidated by rework — a soft signal to re-check the evidence graph).
  evidenceStale: boolean;
  // M12 (ADR-037) Phase 7: merge is blocked because a merge-required artifact
  // is non-current OR a blocking artifact_required gate failed/went stale.
  mergeBlocked: boolean;
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

  const runRows = await client
    .select({
      runId: runs.id,
      taskId: runs.taskId,
      status: runs.status,
      acpSessionId: runs.acpSessionId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      agent: executors.agent,
      branch: workspaces.branch,
      removedAt: workspaces.removedAt,
    })
    .from(runs)
    .innerJoin(executors, eq(executors.id, runs.executorId))
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

  // M12 (ADR-037) Phase 7: which latest runs carry ≥1 stale artifact.
  const evidenceStaleRunIds = new Set<string>();

  if (latestRunIds.length > 0) {
    const staleRows: Array<{ runId: string }> = await client
      .select({ runId: artifactInstances.runId })
      .from(artifactInstances)
      .where(
        and(
          inArray(artifactInstances.runId, latestRunIds),
          eq(artifactInstances.validity, "stale"),
        ),
      );

    for (const r of staleRows) evidenceStaleRunIds.add(r.runId);
  }

  // M12 (ADR-037) Phase 7: which latest runs are merge-blocked, via either
  // (a) a merge-required def that has NO current row (per-def-current — PR1/F2;
  //     stale/superseded history never blocks once the def is re-produced), or
  // (b) a blocking artifact_required gate that failed or went stale.
  const mergeBlockedRunIds = new Set<string>();

  if (latestRunIds.length > 0) {
    // Distinct (runId, defId) pairs any row marks merge-required.
    const requiredDefRows: Array<{
      runId: string;
      artifactDefId: string | null;
    }> = await client
      .select({
        runId: artifactInstances.runId,
        artifactDefId: artifactInstances.artifactDefId,
      })
      .from(artifactInstances)
      .where(
        and(
          inArray(artifactInstances.runId, latestRunIds),
          sql`${artifactInstances.requiredFor} @> ${JSON.stringify(["merge"])}::jsonb`,
        ),
      );

    // (runId, defId) pairs that DO have a current row.
    const currentPairs = new Set<string>();
    const currentRows: Array<{
      runId: string;
      artifactDefId: string | null;
    }> = await client
      .select({
        runId: artifactInstances.runId,
        artifactDefId: artifactInstances.artifactDefId,
      })
      .from(artifactInstances)
      .where(
        and(
          inArray(artifactInstances.runId, latestRunIds),
          eq(artifactInstances.validity, "current"),
        ),
      );

    for (const r of currentRows) {
      if (r.artifactDefId) currentPairs.add(`${r.runId}:${r.artifactDefId}`);
    }

    for (const r of requiredDefRows) {
      if (
        r.artifactDefId &&
        !currentPairs.has(`${r.runId}:${r.artifactDefId}`)
      ) {
        mergeBlockedRunIds.add(r.runId);
      }
    }

    // Only the latest attempt's gate verdict is live: a stale row left by a
    // prior attempt is retired once the node re-runs and re-evaluates its gate
    // (mirrors per-def-current for artifacts). Keyed on node-attempt lineage.
    const attemptRows: Array<{
      id: string;
      runId: string;
      nodeId: string;
      attempt: number;
    }> = await client
      .select({
        id: nodeAttempts.id,
        runId: nodeAttempts.runId,
        nodeId: nodeAttempts.nodeId,
        attempt: nodeAttempts.attempt,
      })
      .from(nodeAttempts)
      .where(inArray(nodeAttempts.runId, latestRunIds));

    const bestAttempt = new Map<string, { id: string; attempt: number }>();

    for (const a of attemptRows) {
      const key = `${a.runId}:${a.nodeId}`;
      const cur = bestAttempt.get(key);

      if (!cur || a.attempt > cur.attempt) {
        bestAttempt.set(key, { id: a.id, attempt: a.attempt });
      }
    }

    const liveAttemptIds = new Set([...bestAttempt.values()].map((v) => v.id));

    const blockedGateRows: Array<{
      runId: string;
      nodeAttemptId: string;
      status: string;
      inputArtifactRefs: string[] | null;
    }> = await client
      .select({
        runId: gateResults.runId,
        nodeAttemptId: gateResults.nodeAttemptId,
        status: gateResults.status,
        inputArtifactRefs: gateResults.inputArtifactRefs,
      })
      .from(gateResults)
      .where(
        and(
          inArray(gateResults.runId, latestRunIds),
          eq(gateResults.kind, "artifact_required"),
          eq(gateResults.mode, "blocking"),
          inArray(gateResults.status, ["failed", "stale"]),
        ),
      );

    for (const r of blockedGateRows) {
      if (!liveAttemptIds.has(r.nodeAttemptId)) continue;

      // Mirror assertEvidenceReady Check 2: a `failed` gate whose required
      // inputs are ALL current again would pass today, so it no longer blocks
      // merge. A `stale` gate always blocks (needs a re-run). Keeps the board
      // badge consistent with the authoritative readiness verdict.
      if (r.status === "failed") {
        const refs = r.inputArtifactRefs ?? [];
        const stillMissing =
          refs.length === 0 ||
          refs.some((ref) => !currentPairs.has(`${r.runId}:${ref}`));

        if (!stillMissing) continue;
      }

      mergeBlockedRunIds.add(r.runId);
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
        title: task.title,
        prompt: task.prompt,
        flowRef: task.flowRef,
        priority: priorityFor(backlogPos),
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
      runId: run.runId,
      branch: run.branch,
      agent: takeover ? "dev" : run.agent,
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
      evidenceStale:
        cardStatus !== "done" && evidenceStaleRunIds.has(run.runId),
      mergeBlocked: cardStatus !== "done" && mergeBlockedRunIds.has(run.runId),
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
