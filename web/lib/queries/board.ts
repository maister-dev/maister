import "server-only";

import type { BoardColumn, CrashAction } from "@/lib/board";
import type { GateResultStatus, RunStatus, StepRun } from "@/lib/db/schema";
import type {
  ReadinessContribution,
  ReadinessState,
} from "@/lib/flows/graph/readiness-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { crashActionFor, deriveStage } from "@/lib/board";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  gateStatusContribution,
  latestAttemptIdsByNode,
  liveBlockingGates,
  rollupReadiness,
} from "@/lib/flows/graph/readiness-core";

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
  // T15 (M15): unified readiness summary badge, replacing the three separate
  // booleans (evidenceStale, mergeBlocked, externalGatePending). Computed over
  // the same bulk-fetched gate_results + artifact_instances + node_attempts rows
  // using readiness-core.ts (SSOT shared with assertEvidenceReady,
  // getRunReadiness) — no per-run getRunReadiness call, no N+1.
  // State = "ready" | "blocked" | "stale" | "failed" | "waiting" | "overridden".
  // Only rendered when readiness !== "ready" AND status !== "done".
  // Done cards always read "ready" (mirrors the old done-zeroing).
  readiness: ReadinessState;
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

// T15 (M15, ADR-048): the unified readiness state per run, batched across all
// latest runs (no per-run query, no N+1). Bulk-fetches node_attempts +
// gate_results + artifact_instances once, groups by runId in memory, and
// classifies each run through the shared readiness-core SSOT — the same gate
// contributions assertEvidenceReady / getRunReadiness apply, plus the
// review-phase required-artifact stale/missing contributions.
async function computeReadinessByRun(
  client: NodePgDatabase<typeof schema>,
  latestRunIds: string[],
): Promise<Map<string, ReadinessState>> {
  const readinessByRun = new Map<string, ReadinessState>();

  if (latestRunIds.length === 0) return readinessByRun;

  // Live-attempt lineage: latest attempt per (runId, nodeId). nodeIds repeat
  // across runs, so grouping must stay run-scoped.
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

  // All gate_results on the latest runs (every kind, every status). The
  // blocking + live-attempt + external-collapse filtering happens in
  // liveBlockingGates (SSOT).
  const gateRows: Array<{
    id: string;
    runId: string;
    nodeAttemptId: string;
    gateId: string;
    kind: string;
    mode: string;
    status: GateResultStatus;
    createdAt: Date;
  }> = await client
    .select({
      id: gateResults.id,
      runId: gateResults.runId,
      nodeAttemptId: gateResults.nodeAttemptId,
      gateId: gateResults.gateId,
      kind: gateResults.kind,
      mode: gateResults.mode,
      status: gateResults.status,
      createdAt: gateResults.createdAt,
    })
    .from(gateResults)
    .where(inArray(gateResults.runId, latestRunIds));

  // Required-artifact rows for the review phase, plus the validity of each
  // (runId, defId)'s current row. requiredFor is JSONB; filter in JS so the
  // computation is dialect-agnostic.
  const artifactRows: Array<{
    runId: string;
    artifactDefId: string | null;
    validity: string;
    requiredFor: string[] | null;
  }> = await client
    .select({
      runId: artifactInstances.runId,
      artifactDefId: artifactInstances.artifactDefId,
      validity: artifactInstances.validity,
      requiredFor: artifactInstances.requiredFor,
    })
    .from(artifactInstances)
    .where(inArray(artifactInstances.runId, latestRunIds));

  const attemptsByRun = new Map<string, typeof attemptRows>();
  const gatesByRun = new Map<string, typeof gateRows>();
  const artifactsByRun = new Map<string, typeof artifactRows>();

  for (const a of attemptRows) {
    (
      attemptsByRun.get(a.runId) ?? attemptsByRun.set(a.runId, []).get(a.runId)!
    ).push(a);
  }
  for (const g of gateRows) {
    (gatesByRun.get(g.runId) ?? gatesByRun.set(g.runId, []).get(g.runId)!).push(
      g,
    );
  }
  for (const r of artifactRows) {
    (
      artifactsByRun.get(r.runId) ??
      artifactsByRun.set(r.runId, []).get(r.runId)!
    ).push(r);
  }

  for (const runId of latestRunIds) {
    const liveAttemptIds = latestAttemptIdsByNode(
      attemptsByRun.get(runId) ?? [],
    );
    const blocking = liveBlockingGates(
      gatesByRun.get(runId) ?? [],
      liveAttemptIds,
    );
    const gateContributions: ReadinessContribution[] = blocking.map((g) =>
      gateStatusContribution(g.status),
    );

    // Required-artifact classification mirrors getRunReadiness (current-row
    // presence only). Task 21 reconciles both to the contract's stale→"stale" +
    // phase-aware rules via readiness-core.
    //
    // A required def is satisfied iff a validity="current" row exists for it.
    // Any def with requiredFor non-empty (any phase) is in scope — identical to
    // getRunReadiness's requiredFor NON-EMPTY filter.
    const requiredRows = (artifactsByRun.get(runId) ?? []).filter(
      (r) =>
        r.artifactDefId &&
        Array.isArray(r.requiredFor) &&
        r.requiredFor.length > 0,
    );
    const requiredDefIds = new Set(
      requiredRows.map((r) => r.artifactDefId as string),
    );
    const presentDefIds = new Set<string>();

    for (const r of artifactsByRun.get(runId) ?? []) {
      if (r.artifactDefId && r.validity === "current") {
        presentDefIds.add(r.artifactDefId);
      }
    }

    const artifactContributions: ReadinessContribution[] = [];

    for (const defId of requiredDefIds) {
      if (!presentDefIds.has(defId)) artifactContributions.push("blocked");
    }

    readinessByRun.set(
      runId,
      rollupReadiness([...artifactContributions, ...gateContributions]),
    );
  }

  return readinessByRun;
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

  // T15 (M15, ADR-048): the unified readiness state per latest run, replacing
  // the M12 evidenceStale/mergeBlocked + M16 externalGatePending booleans.
  // Computed over the SAME bulk-fetched node_attempts + gate_results +
  // artifact_instances rows via the shared readiness-core classifier
  // (gateStatusContribution + liveBlockingGates + rollupReadiness) — no per-run
  // getRunReadiness call, no N+1. The review-phase required-artifact contributions
  // mirror getRunReadiness: a stale required-artifact row → "stale"; a required
  // def with no current row → "blocked".
  const readinessByRun = await computeReadinessByRun(client, latestRunIds);

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
      // Done cards always read "ready" — terminal, no actionable readiness badge.
      readiness:
        cardStatus === "done"
          ? "ready"
          : (readinessByRun.get(run.runId) ?? "ready"),
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
