import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { runnerAgentFromFields } from "@/lib/queries/runner-agent";

const { hitlRequests, runs, stepRuns, workspaces } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export type ActivityAgent = "claude" | "codex" | "dev";

export interface ActivityEvent {
  id: string;
  agent: ActivityAgent;
  title: string;
  code: string | null;
  meta: string;
  time: string;
  at: Date;
}

const FEED_LIMIT = 30;

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

export async function getActivityFeed(
  projectId: string,
): Promise<ActivityEvent[]> {
  const now = new Date();
  const client = db();

  const runRows = await client
    .select({
      runId: runs.id,
      status: runs.status,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      capabilityAgent: runs.capabilityAgent,
      runnerSnapshot: runs.runnerSnapshot,
      branch: workspaces.branch,
      flowVersion: runs.flowVersion,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.startedAt))
    .limit(FEED_LIMIT);

  const events: ActivityEvent[] = [];
  const runIds = runRows.map((r) => r.runId);

  for (const row of runRows) {
    const at = row.endedAt ?? row.startedAt;
    const agent = runnerAgentFromFields({
      capabilityAgent: row.capabilityAgent,
      runnerSnapshot: row.runnerSnapshot,
      context: row.runId,
    });

    events.push({
      id: `run-${row.runId}`,
      agent,
      title: titleForRun(row.status),
      code: row.branch,
      meta: `${row.branch} · ${row.flowVersion}`,
      time: relativeTime(at, now),
      at,
    });
  }

  if (runIds.length > 0) {
    const stepRows = await client
      .select({
        id: stepRuns.id,
        runId: stepRuns.runId,
        stepId: stepRuns.stepId,
        status: stepRuns.status,
        endedAt: stepRuns.endedAt,
        startedAt: stepRuns.startedAt,
        branch: workspaces.branch,
        capabilityAgent: runs.capabilityAgent,
        runnerSnapshot: runs.runnerSnapshot,
      })
      .from(stepRuns)
      .innerJoin(runs, eq(runs.id, stepRuns.runId))
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(inArray(stepRuns.runId, runIds))
      .orderBy(desc(stepRuns.startedAt))
      .limit(FEED_LIMIT);

    for (const step of stepRows) {
      const at = step.endedAt ?? step.startedAt;
      const agent = runnerAgentFromFields({
        capabilityAgent: step.capabilityAgent,
        runnerSnapshot: step.runnerSnapshot,
        context: step.runId,
      });

      events.push({
        id: `step-${step.id}`,
        agent,
        title: `${agent} ${step.status.toLowerCase()} step`,
        code: step.stepId,
        meta: `${step.branch} · ${step.stepId}`,
        time: relativeTime(at, now),
        at,
      });
    }

    const hitlRows = await client
      .select({
        id: hitlRequests.id,
        kind: hitlRequests.kind,
        prompt: hitlRequests.prompt,
        respondedAt: hitlRequests.respondedAt,
        createdAt: hitlRequests.createdAt,
        branch: workspaces.branch,
        runId: runs.id,
        capabilityAgent: runs.capabilityAgent,
        runnerSnapshot: runs.runnerSnapshot,
      })
      .from(hitlRequests)
      .innerJoin(runs, eq(runs.id, hitlRequests.runId))
      .innerJoin(workspaces, eq(workspaces.runId, runs.id))
      .where(inArray(hitlRequests.runId, runIds))
      .orderBy(desc(hitlRequests.createdAt))
      .limit(FEED_LIMIT);

    for (const hitl of hitlRows) {
      const at = hitl.respondedAt ?? hitl.createdAt;
      const agent = runnerAgentFromFields({
        capabilityAgent: hitl.capabilityAgent,
        runnerSnapshot: hitl.runnerSnapshot,
        context: hitl.runId,
      });

      events.push({
        id: `hitl-${hitl.id}`,
        agent,
        title: hitl.respondedAt
          ? `${agent} resolved ${hitl.kind}`
          : `${agent} paused at ${hitl.kind}`,
        code: hitl.kind,
        meta: `${hitl.branch} · ${hitl.prompt}`,
        time: relativeTime(at, now),
        at,
      });
    }
  }

  return events
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, FEED_LIMIT);
}

function titleForRun(status: string): string {
  switch (status) {
    case "Done":
      return "run merged → main";
    case "Review":
      return "run opened for review";
    case "Crashed":
    case "Failed":
      return `run ${status.toLowerCase()}`;
    case "NeedsInput":
    case "NeedsInputIdle":
      return "run paused · needs input";
    case "Pending":
      return "run queued";
    default:
      return "run running";
  }
}
