import "server-only";

import type { Assignment, HitlRequest } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { runnerAgentFromFields } from "@/lib/queries/runner-agent";

const {
  actorIdentities,
  assignments,
  flows,
  hitlRequests,
  runs,
  workspaces,
} = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export type HitlAgent = "claude" | "codex";

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
  prompt: string;
  options: HitlOption[];
  time: string;
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
      createdAt: hitlRequests.createdAt,
      capabilityAgent: runs.capabilityAgent,
      runnerSnapshot: runs.runnerSnapshot,
      branch: workspaces.branch,
      flowRef: flows.flowRefId,
    })
    .from(hitlRequests)
    .innerJoin(runs, eq(runs.id, hitlRequests.runId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(flows, eq(flows.id, runs.flowId))
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

  const items: HitlItem[] = rows.map((row) => {
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
      prompt: row.prompt,
      options: extractOptions(row.kind, row.rawSchema),
      time: relativeTime(row.createdAt, now),
    };
  });

  return {
    items,
    count: items.length,
    oldest: items.length > 0 ? items[0].time : null,
  };
}
