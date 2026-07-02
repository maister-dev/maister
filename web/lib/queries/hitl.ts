import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { Assignment, HitlRequest, RunnerSnapshot } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  activeSessionCapabilityAgent,
  activeSessionRunnerSnapshot,
} from "@/lib/runs/active-run-session";
import { resolveStages, type StageChip } from "@/lib/queries/hitl-stage";
import { runnerAgentFromFields } from "@/lib/queries/runner-agent";

const {
  actorIdentities,
  assignments,
  flows,
  hitlRequests,
  projects,
  runs,
  tasks,
  workspaces,
} = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

/**
 * Returns pending (respondedAt IS NULL) hitl_requests rows for the given run,
 * scoped to the given projectId so callers cannot leak rows across projects.
 * Consumed by the P6 external-access list route.
 */
export async function getHitlRequestsForRun(
  runId: string,
  projectId: string,
  deps?: { db?: NodePgDatabase<typeof schema> },
): Promise<HitlRequest[]> {
  const client = deps?.db ?? db();

  // Verify the run belongs to the declared projectId AND is genuinely awaiting
  // input. A HITL is pending ONLY while the run is NeedsInput/NeedsInputIdle —
  // matching getHitlInbox/getCrossProjectHitlInbox. Otherwise (Running,
  // HumanWorking, Failed, Abandoned, Done) an unanswered row is stale and MUST
  // NOT be surfaced to external clients even when respondedAt stayed null.
  const runRows = await client
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.projectId, projectId),
        inArray(runs.status, ["NeedsInput", "NeedsInputIdle"]),
      ),
    );

  if (runRows.length === 0) {
    return [];
  }

  return client
    .select()
    .from(hitlRequests)
    .where(and(eq(hitlRequests.runId, runId), isNull(hitlRequests.respondedAt)))
    .orderBy(asc(hitlRequests.createdAt));
}

export type HitlAgent = AdapterId;

export interface HitlOption {
  optionId: string;
  label: string;
}

export interface HitlItem {
  hitlRequestId: string;
  runId: string;
  kind: HitlRequest["kind"];
  assignmentId: string | null;
  assignmentStatus: Assignment["status"] | null;
  assignmentActionKind: Assignment["actionKind"] | null;
  assignmentRoleRefs: string[];
  assignmentStaleEvidenceSummary: Record<string, unknown> | null;
  assigneeLabel: string | null;
  assigneeUserId: string | null;
  agent: HitlAgent;
  branch: string;
  flowRef: string;
  // Originating flow node: label (= step_id) + resolved node kind.
  stage: StageChip;
  // ADR-078: KEY-N of the launching task (null for scratch-run HITL).
  taskRef: string | null;
  // Human task title (null for scratch-run HITL).
  taskTitle: string | null;
  prompt: string;
  options: HitlOption[];
  time: string;
  // Absolute ISO 8601 counterpart of the relative `time` — the external
  // inbox contract (ExtHitlInboxItem.createdAt) needs the raw timestamp.
  createdAt: string;
  schema: unknown;
  criticality: "low" | "medium" | "high" | "critical" | null;
}

export interface HitlInbox {
  items: HitlItem[];
  count: number;
  oldest: string | null;
}

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

export function extractOptions(
  kind: HitlRequest["kind"],
  raw: unknown,
): HitlOption[] {
  if (raw === null || typeof raw !== "object") return [];
  const opts = (raw as { options?: unknown }).options;

  if (!Array.isArray(opts)) return [];

  return opts
    .map((o) => {
      if (o === null || typeof o !== "object") return null;
      const optionId = (o as { optionId?: unknown }).optionId;

      if (typeof optionId !== "string" || optionId.length === 0) return null;
      const label = (o as { label?: unknown }).label;

      return {
        optionId,
        label: typeof label === "string" && label.length > 0 ? label : optionId,
      };
    })
    .filter((o): o is HitlOption => o !== null)
    .concat(
      kind === "permission" && opts.length === 0
        ? [
            { optionId: "allow", label: "allow this run" },
            { optionId: "deny", label: "deny" },
          ]
        : [],
    );
}

// Shared select shape for hitl_requests rows (used by getHitlInbox and getCrossProjectHitlInbox).
export type HitlRowBase = {
  hitlRequestId: string;
  runId: string;
  kind: HitlRequest["kind"];
  prompt: string;
  rawSchema: unknown;
  criticality: "low" | "medium" | "high" | "critical" | null;
  createdAt: Date;
  capabilityAgent: AdapterId | null;
  runnerSnapshot: RunnerSnapshot | null;
  branch: string;
  flowRef: string;
  taskNumber: number | null;
  taskKey: string | null;
  taskTitle: string | null;
  stepId: string;
  flowRevisionId: string | null;
  flowId: string | null;
};

// Map a batch of HitlRowBase rows + pre-fetched assignment/actor maps to HitlItem[].
export function mapRowsToHitlItems(
  rows: HitlRowBase[],
  assignmentsByHitlId: Map<
    string | null,
    {
      id: string;
      status: Assignment["status"];
      actionKind: Assignment["actionKind"];
      roleRefs: string[];
      staleEvidenceSummary: Record<string, unknown> | null;
      assigneeActorId: string | null;
    }
  >,
  actorsById: Map<
    string,
    { id: string; label: string | null; userId: string | null }
  >,
  stagesByHitlId: Map<string, StageChip>,
  now: Date,
): HitlItem[] {
  return rows.map((row) => {
    const assignment = assignmentsByHitlId.get(row.hitlRequestId) ?? null;
    const assignee =
      assignment?.assigneeActorId != null
        ? (actorsById.get(assignment.assigneeActorId) ?? null)
        : null;

    return {
      hitlRequestId: row.hitlRequestId,
      runId: row.runId,
      kind: row.kind,
      assignmentId: assignment?.id ?? null,
      assignmentStatus: assignment?.status ?? null,
      assignmentActionKind: assignment?.actionKind ?? null,
      assignmentRoleRefs: assignment?.roleRefs ?? [],
      assignmentStaleEvidenceSummary: assignment?.staleEvidenceSummary ?? null,
      assigneeLabel: assignee?.label ?? null,
      assigneeUserId: assignee?.userId ?? null,
      agent: runnerAgentFromFields({
        capabilityAgent: row.capabilityAgent,
        runnerSnapshot: row.runnerSnapshot,
        context: row.runId,
      }),
      branch: row.branch,
      flowRef: row.flowRef,
      stage: stagesByHitlId.get(row.hitlRequestId) ?? {
        label: row.stepId,
        type: null,
      },
      taskRef:
        row.taskNumber !== null && row.taskKey
          ? `${row.taskKey}-${row.taskNumber}`
          : null,
      taskTitle: row.taskTitle,
      prompt: row.prompt,
      options: extractOptions(row.kind, row.rawSchema),
      time: relativeTime(row.createdAt, now),
      createdAt: row.createdAt.toISOString(),
      // Permission schemas carry supervisor-internal handles (requestId,
      // supervisorSessionId, toolCall) written by runner-agent — NEVER serialize
      // them to the browser. Mirrors the ext-API DTO guard; the actionable
      // surface for permission is `options` (already projected above).
      schema: row.kind === "permission" ? null : row.rawSchema,
      criticality: row.criticality,
    };
  });
}

export async function getHitlInbox(projectId: string): Promise<HitlInbox> {
  const now = new Date();
  const client = db();

  const projectRunIds = await client
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        inArray(runs.status, ["NeedsInput", "NeedsInputIdle"]),
      ),
    );

  if (projectRunIds.length === 0) {
    return { items: [], count: 0, oldest: null };
  }

  const runIds = projectRunIds.map((r) => r.id);

  const rows = await client
    .select({
      hitlRequestId: hitlRequests.id,
      runId: hitlRequests.runId,
      kind: hitlRequests.kind,
      prompt: hitlRequests.prompt,
      rawSchema: hitlRequests.schema,
      criticality: hitlRequests.criticality,
      createdAt: hitlRequests.createdAt,
      capabilityAgent: activeSessionCapabilityAgent(runs.id),
      runnerSnapshot: activeSessionRunnerSnapshot(runs.id),
      branch: workspaces.branch,
      flowRef: sql<string>`coalesce(${flows.flowRefId}, 'scratch')`,
      taskNumber: tasks.number,
      taskKey: projects.taskKey,
      taskTitle: tasks.title,
      stepId: hitlRequests.stepId,
      flowRevisionId: runs.flowRevisionId,
      flowId: runs.flowId,
    })
    .from(hitlRequests)
    .innerJoin(runs, eq(runs.id, hitlRequests.runId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .leftJoin(flows, eq(flows.id, runs.flowId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(
      and(
        inArray(hitlRequests.runId, runIds),
        isNull(hitlRequests.respondedAt),
      ),
    )
    .orderBy(asc(hitlRequests.createdAt));
  const hitlIds = rows.map((row) => row.hitlRequestId);
  const assignmentRows =
    hitlIds.length > 0
      ? await client
          .select()
          .from(assignments)
          .where(inArray(assignments.hitlRequestId, hitlIds))
      : [];
  const actorIds = assignmentRows
    .map((assignment) => assignment.assigneeActorId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const actorRows =
    actorIds.length > 0
      ? await client
          .select({
            id: actorIdentities.id,
            label: actorIdentities.label,
            userId: actorIdentities.userId,
          })
          .from(actorIdentities)
          .where(inArray(actorIdentities.id, actorIds))
      : [];
  const actorsById = new Map(actorRows.map((actor) => [actor.id, actor]));
  const assignmentsByHitlId = new Map(
    assignmentRows.map((assignment) => [assignment.hitlRequestId, assignment]),
  );

  const stagesByHitlId = await resolveStages(client, rows);
  const items = mapRowsToHitlItems(
    rows,
    assignmentsByHitlId,
    actorsById,
    stagesByHitlId,
    now,
  );

  return {
    items,
    count: items.length,
    oldest: items.length > 0 ? items[0].time : null,
  };
}
