import "server-only";

import type { Db } from "./db";
import type { ExecutionHosts } from "./client";
import type { ExecutionRuntimeObject } from "@/lib/db/schema";

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { executionHosts as defaultExecutionHosts } from "./client";
import { getAssignmentById } from "./assignments";

import {
  artifactInstances,
  executionCommands,
  executionRuntimeObjects,
  runSessionIncarnations,
  scratchAttachments,
} from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";

const RETENTION_BATCH_SIZE = 100;

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
  failed: number;
};

export type RuntimeObjectRetentionOptions = {
  db?: Db;
  hosts?: ExecutionHosts;
  now?: Date;
  limit?: number;
  logger?: Logger;
};

async function hasDurableReference(
  tx: Db,
  object: ExecutionRuntimeObject,
): Promise<boolean> {
  const [artifact, attachment] = await Promise.all([
    tx
      .select({ id: artifactInstances.id })
      .from(artifactInstances)
      .where(
        and(
          eq(artifactInstances.runId, object.runId),
          sql`${artifactInstances.locator}->>'kind' = 'execution-object'`,
          sql`${artifactInstances.locator}->>'objectId' = ${object.id}`,
        ),
      )
      .limit(1),
    tx
      .select({ id: scratchAttachments.id })
      .from(scratchAttachments)
      .where(
        and(
          eq(scratchAttachments.runId, object.runId),
          eq(scratchAttachments.kind, "uploaded_file"),
          eq(scratchAttachments.value, object.id),
        ),
      )
      .limit(1),
  ]);

  return Boolean(artifact[0] || attachment[0]);
}

async function hasLiveRunSession(tx: Db, runId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: runSessionIncarnations.id })
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.runId, runId),
        inArray(runSessionIncarnations.state, [
          "created",
          "active",
          "checkpointed",
        ]),
      ),
    )
    .limit(1);

  return Boolean(rows[0]);
}

async function hasOpenDeleteCommand(
  tx: Db,
  objectId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.kind, "runtime_object.delete"),
        eq(executionCommands.targetSessionId, objectId),
        inArray(executionCommands.state, ["queued", "delivering", "accepted"]),
      ),
    )
    .limit(1);

  return Boolean(rows[0]);
}

function safeError(error: unknown): Record<string, unknown> {
  return {
    code: isMaisterError(error) ? error.code : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  };
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
    failed: 0,
  };
  const candidates = await db
    .select()
    .from(executionRuntimeObjects)
    .where(
      and(
        eq(executionRuntimeObjects.retentionClass, "ephemeral"),
        eq(executionRuntimeObjects.state, "available"),
        lte(executionRuntimeObjects.expiresAt, now),
      ),
    )
    .limit(limit);

  for (const candidate of candidates) {
    summary.scanned += 1;
    if (await hasDurableReference(db, candidate)) {
      summary.referenced += 1;
      continue;
    }
    if (await hasLiveRunSession(db, candidate.runId)) {
      summary.activeSession += 1;
      continue;
    }
    if (await hasOpenDeleteCommand(db, candidate.id)) {
      summary.deferred += 1;
      continue;
    }
    if (
      !candidate.executionAssignmentId ||
      candidate.assignmentEpoch === null
    ) {
      summary.failed += 1;
      await db
        .update(executionRuntimeObjects)
        .set({
          lastError: {
            code: "PRECONDITION",
            message: "expired runtime object has no assignment binding",
          },
        })
        .where(eq(executionRuntimeObjects.id, candidate.id));
      continue;
    }

    const assignment = await getAssignmentById(
      db,
      candidate.executionAssignmentId,
    );

    if (!assignment || assignment.epoch !== candidate.assignmentEpoch) {
      summary.failed += 1;
      await db
        .update(executionRuntimeObjects)
        .set({
          lastError: {
            code: "PRECONDITION",
            message: "expired runtime object assignment binding is missing",
          },
        })
        .where(eq(executionRuntimeObjects.id, candidate.id));
      continue;
    }

    try {
      const client = await hosts.forAssignment(assignment);

      await client.deleteRuntimeObject({
        objectId: candidate.id,
        generation: candidate.generation,
      });
      summary.deleted += 1;
    } catch (error) {
      if (await hasOpenDeleteCommand(db, candidate.id)) {
        summary.deferred += 1;
      } else {
        summary.failed += 1;
        await db
          .update(executionRuntimeObjects)
          .set({ state: "available", lastError: safeError(error) })
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

  logger.info(summary, "runtime-object-retention-sweep-completed");

  return summary;
}

type RetentionTimerState = { handle: NodeJS.Timeout | null };
const RETENTION_TIMER_KEY = Symbol.for("maister.runtime-object-retention.v1");

function timerState(): RetentionTimerState {
  const global = globalThis as unknown as Record<symbol, RetentionTimerState>;

  global[RETENTION_TIMER_KEY] ??= { handle: null };

  return global[RETENTION_TIMER_KEY];
}

export function startRuntimeObjectRetentionTimer(): void {
  const state = timerState();

  if (state.handle) return;
  state.handle = setInterval(() => {
    void sweepExpiredRuntimeObjects().catch((error: unknown) => {
      defaultLog.error(
        { error: safeError(error) },
        "runtime-object-retention-sweep-failed",
      );
    });
  }, RUNTIME_OBJECT_RETENTION_INTERVAL_MS);
  state.handle.unref?.();
}

export function stopRuntimeObjectRetentionTimer(): void {
  const state = timerState();

  if (!state.handle) return;
  clearInterval(state.handle);
  state.handle = null;
}
