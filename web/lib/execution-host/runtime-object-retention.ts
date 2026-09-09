import "server-only";

import type { Db } from "./db";
import type { ExecutionHosts } from "./client";
import type { RuntimeObjectHoldReason } from "./types";
import type { ExecutionRuntimeObject } from "@/lib/db/schema";

import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { executionHosts as defaultExecutionHosts } from "./client";
import { getAssignmentById } from "./assignments";
import {
  evaluateRuntimeObjectHold,
  hasOpenRuntimeObjectCommand,
  RuntimeObjectHeldError,
} from "./runtime-object-holds";

import {
  executionRuntimeObjectRetentionProgress,
  executionRuntimeObjects,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { gcAgeDays } from "@/lib/instance-config";
import { DISPOSABLE_WORKSPACE_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import { isApplicationStopping } from "@/lib/server-lifecycle";

const RETENTION_BATCH_SIZE = 100;
const PROGRESS_ID = "default";

export const RUNTIME_OBJECT_RETENTION_INTERVAL_MS = 60_000;

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "runtime-object-retention" });

export type RuntimeObjectRetentionSummary = {
  scanned: number;
  deleted: number;
  deferred: number;
  referenced: number;
  activeSession: number;
  protected: number;
  failed: number;
};

export type RuntimeObjectRetentionOptions = {
  db?: Db;
  hosts?: ExecutionHosts;
  now?: Date;
  limit?: number;
  logger?: Logger;
};

// created_at travels as text: a JS Date would truncate Postgres microseconds
// and the keyset would re-examine its own boundary row.
type Cursor = { createdAt: string; id: string } | null;

function safeError(error: unknown): Record<string, unknown> {
  return {
    code: isMaisterError(error) ? error.code : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function loadCursor(
  db: Db,
): Promise<{ cursor: Cursor; updatedAt: Date }> {
  await db
    .insert(executionRuntimeObjectRetentionProgress)
    .values({ id: PROGRESS_ID })
    .onConflictDoNothing();
  const [row] = await db
    .select({
      cursorCreatedAt: sql<
        string | null
      >`${executionRuntimeObjectRetentionProgress.cursorCreatedAt}::text`,
      cursorId: executionRuntimeObjectRetentionProgress.cursorId,
      updatedAt: executionRuntimeObjectRetentionProgress.updatedAt,
    })
    .from(executionRuntimeObjectRetentionProgress)
    .where(eq(executionRuntimeObjectRetentionProgress.id, PROGRESS_ID));

  return {
    cursor:
      row.cursorCreatedAt && row.cursorId
        ? { createdAt: row.cursorCreatedAt, id: row.cursorId }
        : null,
    updatedAt: row.updatedAt,
  };
}

async function saveCursor(db: Db, cursor: Cursor, now: Date): Promise<void> {
  await db
    .update(executionRuntimeObjectRetentionProgress)
    .set({
      cursorCreatedAt: cursor ? sql`${cursor.createdAt}::timestamptz` : null,
      cursorId: cursor?.id ?? null,
      updatedAt: now,
    })
    .where(eq(executionRuntimeObjectRetentionProgress.id, PROGRESS_ID));
}

// Due rows in (created_at, id) keyset order: expired ephemeral objects, run and
// delivery objects of a disposable run past the workspace GC deadline, and the
// deleting cleanup queue. Holds are evaluated later, under the row lock.
async function dueCandidates(
  db: Db,
  cursor: Cursor,
  now: Date,
  limit: number,
): Promise<(ExecutionRuntimeObject & { createdAtText: string })[]> {
  const deadline = sql`COALESCE((SELECT max(${workspaces.scheduledRemovalAt}) FROM ${workspaces} WHERE ${workspaces.runId} = ${executionRuntimeObjects.runId}), ${runs.endedAt} + make_interval(days => ${gcAgeDays()}))`;
  const rows = await db
    .select({
      object: executionRuntimeObjects,
      createdAtText: sql<string>`${executionRuntimeObjects.createdAt}::text`,
    })
    .from(executionRuntimeObjects)
    .leftJoin(runs, eq(runs.id, executionRuntimeObjects.runId))
    .where(
      and(
        or(
          and(
            eq(executionRuntimeObjects.state, "available"),
            eq(executionRuntimeObjects.retentionClass, "ephemeral"),
            isNotNull(executionRuntimeObjects.expiresAt),
            lte(executionRuntimeObjects.expiresAt, now),
          ),
          and(
            eq(executionRuntimeObjects.state, "available"),
            inArray(executionRuntimeObjects.retentionClass, [
              "run",
              "delivery",
            ]),
            inArray(runs.status, [...DISPOSABLE_WORKSPACE_RUN_STATUSES]),
            sql`${deadline} <= ${now}`,
          ),
          eq(executionRuntimeObjects.state, "deleting"),
        ),
        cursor
          ? sql`(${executionRuntimeObjects.createdAt}, ${executionRuntimeObjects.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id})`
          : sql`true`,
      ),
    )
    .orderBy(
      asc(executionRuntimeObjects.createdAt),
      asc(executionRuntimeObjects.id),
    )
    .limit(limit);

  return rows.map((row) => ({
    ...row.object,
    createdAtText: row.createdAtText,
  }));
}

async function recordHold(
  db: Db,
  objectId: string,
  reason: RuntimeObjectHoldReason,
  now: Date,
): Promise<void> {
  await db
    .update(executionRuntimeObjects)
    .set({ retentionHold: { reason, at: now.toISOString() } })
    .where(eq(executionRuntimeObjects.id, objectId));
}

async function recordFailure(
  db: Db,
  objectId: string,
  message: string,
  onlyWhileDeleting: boolean,
): Promise<void> {
  await db
    .update(executionRuntimeObjects)
    .set({ lastError: { code: "PRECONDITION", message } })
    .where(
      onlyWhileDeleting
        ? and(
            eq(executionRuntimeObjects.id, objectId),
            eq(executionRuntimeObjects.state, "deleting"),
          )
        : eq(executionRuntimeObjects.id, objectId),
    );
}

export async function sweepExpiredRuntimeObjects(
  options: RuntimeObjectRetentionOptions = {},
): Promise<RuntimeObjectRetentionSummary> {
  const db = options.db ?? getDb();
  const hosts = options.hosts ?? defaultExecutionHosts;
  const now = options.now ?? new Date();
  const limit = options.limit ?? RETENTION_BATCH_SIZE;
  const logger = options.logger ?? defaultLog;
  const summary: RuntimeObjectRetentionSummary = {
    scanned: 0,
    deleted: 0,
    deferred: 0,
    referenced: 0,
    activeSession: 0,
    protected: 0,
    failed: 0,
  };
  const progress = await loadCursor(db);
  const candidates = await dueCandidates(db, progress.cursor, now, limit);
  const held = async (
    candidate: ExecutionRuntimeObject,
    reason: RuntimeObjectHoldReason,
  ): Promise<void> => {
    summary.protected += 1;
    if (reason === "referenced_artifact" || reason === "referenced_attachment")
      summary.referenced += 1;
    if (reason === "live_session") summary.activeSession += 1;
    if (reason === "delete_pending") summary.deferred += 1;
    await recordHold(db, candidate.id, reason, now);
    logger.debug(
      {
        runId: candidate.runId,
        objectId: candidate.id,
        generation: candidate.generation,
        retentionClass: candidate.retentionClass,
        reason,
      },
      "runtime-object-retained",
    );
  };

  for (const candidate of candidates) {
    if (isApplicationStopping()) break;
    summary.scanned += 1;
    if (
      candidate.state === "deleting" &&
      (await hasOpenRuntimeObjectCommand(db, candidate.id))
    ) {
      await held(candidate, "delete_pending");
      continue;
    }
    if (
      !candidate.executionAssignmentId ||
      candidate.assignmentEpoch === null
    ) {
      summary.failed += 1;
      await recordFailure(
        db,
        candidate.id,
        "expired runtime object has no assignment binding",
        false,
      );
      continue;
    }

    const assignment = await getAssignmentById(
      db,
      candidate.executionAssignmentId,
    );

    if (!assignment || assignment.epoch !== candidate.assignmentEpoch) {
      summary.failed += 1;
      await recordFailure(
        db,
        candidate.id,
        "expired runtime object assignment binding is missing",
        false,
      );
      continue;
    }

    try {
      const client = await hosts.forAssignment(assignment);

      await client.deleteRuntimeObject(
        { objectId: candidate.id, generation: candidate.generation },
        {
          guard: async (tx, object) => {
            if (object.state !== "available") return;
            const reason = await evaluateRuntimeObjectHold(tx, object);

            if (reason) throw new RuntimeObjectHeldError(reason);
          },
        },
      );
      summary.deleted += 1;
    } catch (error) {
      if (error instanceof RuntimeObjectHeldError) {
        await held(candidate, error.hold);
        continue;
      }
      if (await hasOpenRuntimeObjectCommand(db, candidate.id)) {
        summary.deferred += 1;
      } else {
        summary.failed += 1;
        await db
          .update(executionRuntimeObjects)
          .set({ lastError: safeError(error) })
          .where(
            and(
              eq(executionRuntimeObjects.id, candidate.id),
              eq(executionRuntimeObjects.state, "deleting"),
            ),
          );
      }
      logger.warn(
        {
          runId: candidate.runId,
          objectId: candidate.id,
          assignmentId: candidate.executionAssignmentId,
          assignmentEpoch: candidate.assignmentEpoch,
          error: safeError(error),
        },
        "runtime-object-retention-delete-failed",
      );
    }
  }

  // A short page means the scan is exhausted: wrap so the next sweep starts
  // over; a full page leaves the marker on the last examined row.
  const last = candidates[candidates.length - 1];
  const cursor: Cursor =
    candidates.length < limit || !last
      ? null
      : { createdAt: last.createdAtText, id: last.id };

  await saveCursor(db, cursor, now);
  logger.info(
    {
      ...summary,
      cursorAgeMs: Math.max(0, now.getTime() - progress.updatedAt.getTime()),
      wrapped: cursor === null,
    },
    "runtime-object-retention-sweep-completed",
  );

  return summary;
}

type RetentionTimerState = {
  handle: NodeJS.Timeout | null;
  active: Promise<void> | null;
};
const RETENTION_TIMER_KEY = Symbol.for("maister.runtime-object-retention.v1");

function timerState(): RetentionTimerState {
  const global = globalThis as unknown as Record<symbol, RetentionTimerState>;

  global[RETENTION_TIMER_KEY] ??= { handle: null, active: null };

  return global[RETENTION_TIMER_KEY];
}

export function startRuntimeObjectRetentionTimer(): void {
  if (isApplicationStopping()) return;
  const state = timerState();

  if (state.handle) return;
  state.handle = setInterval(() => {
    if (state.active) return;
    state.active = sweepExpiredRuntimeObjects()
      .then(() => {})
      .catch((error: unknown) => {
        defaultLog.error(
          { error: safeError(error) },
          "runtime-object-retention-sweep-failed",
        );
      })
      .finally(() => {
        state.active = null;
      });
  }, RUNTIME_OBJECT_RETENTION_INTERVAL_MS);
  state.handle.unref?.();
}

export async function stopRuntimeObjectRetentionTimer(): Promise<void> {
  const state = timerState();

  if (state.handle) clearInterval(state.handle);
  state.handle = null;
  await state.active;
}
