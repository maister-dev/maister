import "server-only";

import type { HitlRequest } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const { executors, flows, hitlRequests, runs, workspaces } = schema;

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
    .where(eq(runs.projectId, projectId));

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
      agent: executors.agent,
      branch: workspaces.branch,
      flowRef: flows.flowRefId,
    })
    .from(hitlRequests)
    .innerJoin(runs, eq(runs.id, hitlRequests.runId))
    .innerJoin(executors, eq(executors.id, runs.executorId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .where(
      and(
        inArray(hitlRequests.runId, runIds),
        isNull(hitlRequests.respondedAt),
      ),
    )
    .orderBy(asc(hitlRequests.createdAt));

  const items: HitlItem[] = rows.map((row) => ({
    hitlRequestId: row.hitlRequestId,
    runId: row.runId,
    kind: row.kind,
    agent: row.agent,
    branch: row.branch,
    flowRef: row.flowRef,
    prompt: row.prompt,
    options: extractOptions(row.kind, row.rawSchema),
    time: relativeTime(row.createdAt, now),
  }));

  return {
    items,
    count: items.length,
    oldest: items.length > 0 ? items[0].time : null,
  };
}
