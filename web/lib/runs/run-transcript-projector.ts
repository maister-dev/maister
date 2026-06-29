import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { TranscriptMessage } from "@/components/run-transcript/transcript-view";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { and, asc, desc, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { runtimeRoot as configuredRuntimeRoot } from "@/lib/instance-config";
import {
  coalesceSessionUpdates,
  type CoalesceEntry,
} from "@/lib/run-transcript/coalesce";

const { localPackages, projects, runMessages, runs } = schema;

type DbClient = NodePgDatabase<typeof schema>;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): DbClient {
  return getDb() as unknown as DbClient;
}

const log = pino({
  name: "run-transcript-projector",
  level: process.env.LOG_LEVEL ?? "info",
});

// Event-line shapes we care about from the durable `run.events.jsonl`. T-B0
// stamps `nodeAttemptId` on every line of a node session; a line without one is
// not attributable to a flow node (scratch / single-session) and is skipped.
type EventLine = {
  type?: string;
  monotonicId?: number;
  nodeAttemptId?: string;
  update?: unknown;
};

const RESET_EVENT_TYPES = new Set([
  "session.permission_request",
  "session.hook_trip",
  "session.exited",
  "session.crashed",
]);

function eventsLogPathForRun(
  runtimeRoot: string,
  slug: string,
  runId: string,
): string {
  return path.join(runDirPath(runtimeRoot, slug, runId), "run.events.jsonl");
}

function parseEventLines(raw: string): EventLine[] {
  const out: EventLine[] = [];

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as EventLine);
    } catch {
      log.warn("skipping malformed run.events.jsonl line");
    }
  }

  return out;
}

export type ProjectRunTranscriptResult = {
  status: "projected" | "missing-run" | "missing-events" | "unchanged";
  nodeAttempts: number;
  rowsUpserted: number;
};

// Reconcile-on-read projector: tail the durable per-run events log, group its
// `session.update` lines by the T-B0-stamped `nodeAttemptId`, coalesce each
// group through the SHARED coalescer, and upsert `run_messages` rows keyed by
// `(run_id, node_attempt_id, sequence)`. Idempotent — re-running re-derives the
// same ordered list and the upsert leaves settled rows untouched (and grows the
// trailing message of an active node in place). Path-confined to the run dir.
export async function projectRunTranscript(
  runId: string,
  opts: { client?: DbClient; runtimeRoot?: string } = {},
): Promise<ProjectRunTranscriptResult> {
  const client = opts.client ?? db();
  const [run] = await client
    .select({
      id: runs.id,
      projectSlug: projects.slug,
      localPackageSlug: localPackages.slug,
    })
    .from(runs)
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(localPackages, eq(localPackages.id, runs.localPackageId))
    .where(eq(runs.id, runId));

  if (!run) return { status: "missing-run", nodeAttempts: 0, rowsUpserted: 0 };

  const slug = run.projectSlug ?? run.localPackageSlug;

  if (!slug) {
    throw new MaisterError(
      "CONFIG",
      `transcript projector owner slug missing for run: ${runId}`,
    );
  }

  const logPath = eventsLogPathForRun(
    opts.runtimeRoot ?? configuredRuntimeRoot(),
    slug,
    runId,
  );
  let raw: string;

  try {
    raw = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing-events", nodeAttempts: 0, rowsUpserted: 0 };
    }

    throw err;
  }

  const lines = parseEventLines(raw);
  // Only attributable lines (carrying a nodeAttemptId) ever become rows, so the
  // resume cursor compares against the highest attributable monotonicId.
  // Run-level lines (e.g. the `run.needs_input` marker) have no nodeAttemptId;
  // counting them here would keep `logMax > dbMax` and defeat the `unchanged`
  // short-circuit while a run sits in NeedsInput, re-deriving on every read.
  const logMax = lines.reduce(
    (m, l) =>
      l.nodeAttemptId && typeof l.monotonicId === "number"
        ? Math.max(m, l.monotonicId)
        : m,
    0,
  );

  // Resume cursor (identical intent to the scratch consumer): the highest
  // supervisor_event_id already projected for this run. If the log has not
  // advanced past it, there is nothing new to derive.
  const existing = await client
    .select({ supervisorEventId: runMessages.supervisorEventId })
    .from(runMessages)
    .where(eq(runMessages.runId, runId));
  const dbMax = existing.reduce((m, r) => {
    const n = r.supervisorEventId ? Number(r.supervisorEventId) : 0;

    return Number.isFinite(n) && n > m ? n : m;
  }, 0);

  if (existing.length > 0 && logMax <= dbMax) {
    return { status: "unchanged", nodeAttempts: 0, rowsUpserted: 0 };
  }

  // Group lines by node attempt, preserving log order within each group.
  const byAttempt = new Map<string, CoalesceEntry[]>();

  for (const line of lines) {
    const attemptId = line.nodeAttemptId;

    if (!attemptId) continue;
    const entries = byAttempt.get(attemptId) ?? [];

    if (line.type === "session.update") {
      entries.push({
        kind: "update",
        update: line.update,
        supervisorEventId: String(line.monotonicId ?? 0),
      });
    } else if (line.type && RESET_EVENT_TYPES.has(line.type)) {
      entries.push({ kind: "reset" });
    }
    byAttempt.set(attemptId, entries);
  }

  // Ownership guard: only attribute to node attempts that genuinely belong to
  // this run. A `nodeAttemptId` stamped on the log is supervisor-supplied; a
  // mis-attributed line must never create a row whose run_id and node_attempt_id
  // point at different runs (which would let the run-scoped transcript route
  // surface another run's output).
  const ownedAttempts = await client
    .select({ id: schema.nodeAttempts.id })
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId));
  const ownedAttemptIds = new Set(ownedAttempts.map((a) => a.id));

  let rowsUpserted = 0;
  let projectedAttempts = 0;

  // Atomic: all attempts/messages commit together or none do. This keeps the
  // resume-cursor (max supervisor_event_id) honest — it can only advance after a
  // COMPLETE projection, so a mid-batch failure rolls back and the next call
  // re-derives the full transcript from `run.events.jsonl` instead of leaving
  // some attempts permanently skipped.
  await client.transaction(async (tx) => {
    for (const [nodeAttemptId, entries] of byAttempt) {
      if (!ownedAttemptIds.has(nodeAttemptId)) {
        log.warn(
          { runId, nodeAttemptId },
          "skipping transcript lines attributed to a node attempt not owned by this run",
        );
        continue;
      }
      projectedAttempts += 1;
      const messages = coalesceSessionUpdates(entries);

      for (const message of messages) {
        await tx
          .insert(runMessages)
          .values({
            id: randomUUID(),
            runId,
            nodeAttemptId,
            sequence: message.sequence,
            role: message.role,
            content: message.content,
            supervisorEventId: message.supervisorEventId,
          })
          .onConflictDoUpdate({
            target: [
              runMessages.runId,
              runMessages.nodeAttemptId,
              runMessages.sequence,
            ],
            set: {
              content: message.content,
              supervisorEventId: message.supervisorEventId,
            },
          });
        rowsUpserted += 1;
      }
    }
  });

  log.debug(
    { runId, lines: lines.length, attempts: projectedAttempts, rowsUpserted },
    "projected run transcript",
  );

  return {
    status: "projected",
    nodeAttempts: projectedAttempts,
    rowsUpserted,
  };
}

export type RunNodeTranscript = {
  messages: TranscriptMessage[];
  // Latest usage of the node's most recent attempt, if the agent reported it.
  usage: { used: number; size: number } | null;
};

// Read model: the transcript for a node's LATEST attempt, as the renderer
// consumes it (raw rows — the shared TranscriptView parses content itself).
export async function getRunNodeTranscript(
  runId: string,
  nodeId: string,
  opts: { client?: DbClient } = {},
): Promise<RunNodeTranscript | null> {
  const client = opts.client ?? db();
  const [attempt] = await client
    .select({ id: schema.nodeAttempts.id })
    .from(schema.nodeAttempts)
    .where(
      and(
        eq(schema.nodeAttempts.runId, runId),
        eq(schema.nodeAttempts.nodeId, nodeId),
      ),
    )
    .orderBy(desc(schema.nodeAttempts.attempt))
    .limit(1);

  // No attempt yet (a pending node, or never-run) → empty transcript. The route
  // (T-B3) validates the nodeId against the compiled graph for unknown nodes.
  if (!attempt) return { messages: [], usage: null };

  const rows = await client
    .select({
      id: runMessages.id,
      role: runMessages.role,
      content: runMessages.content,
      createdAt: runMessages.createdAt,
    })
    .from(runMessages)
    // Filter by BOTH runId and nodeAttemptId — defense-in-depth so a row that
    // was somehow mis-attributed (its run_id ≠ this run) can never surface
    // under this run's authorization.
    .where(
      and(
        eq(runMessages.runId, runId),
        eq(runMessages.nodeAttemptId, attempt.id),
      ),
    )
    .orderBy(asc(runMessages.sequence));

  const messages: TranscriptMessage[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.createdAt.toISOString(),
  }));

  let usage: { used: number; size: number } | null = null;

  for (const r of rows) {
    if (r.role !== "system") continue;
    try {
      const parsed = JSON.parse(r.content) as {
        kind?: string;
        used?: number;
        size?: number;
      };

      if (parsed.kind === "usage") {
        usage = { used: parsed.used ?? 0, size: parsed.size ?? 0 };
      }
    } catch {
      /* not a JSON system payload (e.g. plain text) — ignore */
    }
  }

  return { messages, usage };
}
