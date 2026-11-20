import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionEvent } from "@/lib/db/schema";
import type { ExecutionEventProjector } from "./projector";
import type {
  AcpContextUpdate,
  ContextUsage,
} from "../../../../runtime/acp-context";

import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import pino from "pino";

import { acpContextUpdateType } from "../../../../runtime/acp-context";

import { advanceCompactionTranscriptRevision } from "./compaction-revisions";
import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
import {
  isPrunedContextEvent,
  prepareSessionContent,
  readAcpContextUpdate,
} from "./session-content";
import { runEventWakeBus } from "./run-wake";

import {
  nodeAttempts,
  runContextUsage,
  runContextCompactions,
} from "@/lib/db/schema";

const log = pino({
  name: "context-projector",
  level: process.env.LOG_LEVEL ?? "info",
});

const warnedMalformedUpdates = new Set<string>();
const usageIdentity = [
  runContextUsage.runId,
  runContextUsage.executionHostId,
  runContextUsage.assignmentId,
  runContextUsage.assignmentEpoch,
  runContextUsage.hostSessionId,
  runContextUsage.nodeAttemptId,
];

type PhysicalSession = Pick<
  typeof runContextUsage.$inferInsert,
  | "runId"
  | "executionHostId"
  | "assignmentId"
  | "assignmentEpoch"
  | "hostSessionId"
>;
type Scope = PhysicalSession & { nodeAttemptId: string | null };
type Observation = Scope & {
  sequence: bigint;
  occurredAt: Date;
  commandId: string | null;
};

function physicalSession(event: ExecutionEvent): PhysicalSession | null {
  if (
    event.source !== "host" ||
    event.ingestDisposition !== "accepted" ||
    !event.executionHostId ||
    !event.executionAssignmentId ||
    !event.hostSessionId ||
    event.assignmentEpoch === null
  )
    return null;

  return {
    runId: event.runId,
    executionHostId: event.executionHostId,
    assignmentId: event.executionAssignmentId,
    assignmentEpoch: event.assignmentEpoch,
    hostSessionId: event.hostSessionId,
  };
}

function boundToPhysicalSession(
  table: typeof runContextUsage | typeof runContextCompactions,
  scope: PhysicalSession,
) {
  return and(
    eq(table.runId, scope.runId),
    eq(table.executionHostId, scope.executionHostId),
    eq(table.assignmentId, scope.assignmentId),
    eq(table.assignmentEpoch, scope.assignmentEpoch),
    eq(table.hostSessionId, scope.hostSessionId),
  );
}

function sessionAndAttempt(nodeAttemptId: string | null): (string | null)[] {
  return nodeAttemptId === null ? [null] : [null, nodeAttemptId];
}

async function writeUsage(
  tx: Db,
  observation: Observation,
  usage: ContextUsage | null,
  ownerAttemptId: string | null,
  coverage?: { coverageIncomplete: true },
): Promise<void> {
  const {
    sequence,
    occurredAt,
    commandId: _commandId,
    ...physical
  } = observation;
  const fields = {
    usedTokens: usage?.used ?? null,
    sizeTokens: usage?.size ?? null,
    observedAt: usage ? occurredAt : null,
    usageRunSequence: usage ? sequence : null,
    lastRunSequence: sequence,
    ...coverage,
  };

  await tx
    .insert(runContextUsage)
    .values(
      sessionAndAttempt(ownerAttemptId).map((nodeAttemptId) => ({
        ...physical,
        nodeAttemptId,
        ...fields,
      })),
    )
    .onConflictDoUpdate({
      target: usageIdentity,
      set: fields,
      setWhere: lt(runContextUsage.lastRunSequence, sequence),
    });
}

async function writeCompactionCounts(
  tx: Db,
  physical: PhysicalSession,
  sequence: bigint,
  attempts: ReadonlyArray<string | null>,
  delta: { active: number; completed: number },
): Promise<void> {
  const {
    runId,
    executionHostId,
    assignmentId,
    assignmentEpoch,
    hostSessionId,
  } = physical;

  await tx
    .insert(runContextUsage)
    .values(
      attempts.map((nodeAttemptId) => ({
        runId,
        executionHostId,
        assignmentId,
        assignmentEpoch,
        hostSessionId,
        nodeAttemptId,
        lastRunSequence: sequence,
        compactionRunSequence: sequence,
        activeCompactions: Math.max(0, delta.active),
        completedCompactions: delta.completed,
      })),
    )
    .onConflictDoUpdate({
      target: usageIdentity,
      set: {
        compactionRunSequence: sql`greatest(${runContextUsage.compactionRunSequence}, ${sequence})`,
        activeCompactions: sql`${runContextUsage.activeCompactions} + ${delta.active}`,
        completedCompactions: sql`${runContextUsage.completedCompactions} + ${delta.completed}`,
      },
    });
}

async function projectUsage(
  tx: Db,
  observation: Observation,
  usage: ContextUsage,
): Promise<void> {
  const scope = boundToPhysicalSession(runContextCompactions, observation);
  const [latest] = await tx
    .select()
    .from(runContextCompactions)
    .where(scope)
    .orderBy(desc(runContextCompactions.lastRunSequence))
    .limit(1);

  if (
    latest?.status === "completed" &&
    !latest.afterUsage &&
    latest.commandId !== null &&
    latest.commandId === observation.commandId &&
    latest.nodeAttemptId === observation.nodeAttemptId
  ) {
    const [current] = await tx
      .select({ sequence: runContextUsage.lastRunSequence })
      .from(runContextUsage)
      .where(
        and(
          boundToPhysicalSession(runContextUsage, observation),
          isNull(runContextUsage.nodeAttemptId),
        ),
      );

    if (current?.sequence === latest.lastRunSequence) {
      await tx
        .update(runContextCompactions)
        .set({ afterUsage: usage })
        .where(
          and(
            scope,
            eq(runContextCompactions.compactionId, latest.compactionId),
          ),
        );
      await advanceCompactionTranscriptRevision(
        tx,
        observation.runId,
        latest.nodeAttemptId,
        observation.sequence,
      );
    }
  }
  await writeUsage(tx, observation, usage, observation.nodeAttemptId);
}

async function projectCompaction(
  tx: Db,
  observation: Observation,
  update: Extract<AcpContextUpdate, { kind: "compaction" }>,
): Promise<void> {
  const { sequence, occurredAt, ...scope } = observation;
  const physical = boundToPhysicalSession(runContextCompactions, scope);
  const identity = and(
    physical,
    eq(runContextCompactions.compactionId, update.id),
  );
  const [previous] = await tx
    .select()
    .from(runContextCompactions)
    .where(identity);

  if (previous && previous.lastRunSequence >= sequence) return;
  if (previous && previous.status !== "in_progress") {
    if (previous.status !== update.status)
      log.warn(
        { runId: scope.runId, sequence: String(sequence) },
        "conflicting ACP compaction status",
      );

    return;
  }
  if (previous && update.status === "in_progress") return;
  if (previous) {
    await tx
      .update(runContextCompactions)
      .set({
        status: update.status,
        endedAt: occurredAt,
        lastRunSequence: sequence,
      })
      .where(identity);
  } else {
    const [sample] = await tx
      .select()
      .from(runContextUsage)
      .where(
        and(
          boundToPhysicalSession(runContextUsage, scope),
          scope.nodeAttemptId === null
            ? isNull(runContextUsage.nodeAttemptId)
            : eq(runContextUsage.nodeAttemptId, scope.nodeAttemptId),
        ),
      );
    const [overlapping] = await tx
      .select({ id: runContextCompactions.compactionId })
      .from(runContextCompactions)
      .where(and(physical, eq(runContextCompactions.status, "in_progress")))
      .limit(1);
    const beforeUsage =
      !overlapping && sample?.usedTokens != null && sample.sizeTokens != null
        ? { used: sample.usedTokens, size: sample.sizeTokens }
        : null;

    await tx.insert(runContextCompactions).values({
      ...scope,
      compactionId: update.id,
      status: update.status,
      firstRunSequence: sequence,
      lastRunSequence: sequence,
      startedAt: update.status === "in_progress" ? occurredAt : null,
      endedAt: update.status === "in_progress" ? null : occurredAt,
      beforeUsage,
    });
    if (beforeUsage)
      await advanceCompactionTranscriptRevision(
        tx,
        scope.runId,
        scope.nodeAttemptId,
        sequence,
      );
  }
  const ownerAttemptId = previous
    ? previous.nodeAttemptId
    : scope.nodeAttemptId;
  const completed = update.status === "completed";

  if (completed) await writeUsage(tx, observation, null, ownerAttemptId);
  await writeCompactionCounts(
    tx,
    scope,
    sequence,
    sessionAndAttempt(ownerAttemptId),
    {
      active: previous ? -1 : update.status === "in_progress" ? 1 : 0,
      completed: completed ? 1 : 0,
    },
  );
}

async function projectContext(tx: Db, event: ExecutionEvent): Promise<void> {
  const physical = physicalSession(event);
  const sequence = event.runSequence;

  if (!physical || sequence === null) return;
  if (
    event.eventType === "session.exited" ||
    event.eventType === "session.crashed"
  ) {
    const interrupted = await tx
      .update(runContextCompactions)
      .set({
        status: "interrupted",
        endedAt: event.occurredAt,
        lastRunSequence: sequence,
      })
      .where(
        and(
          boundToPhysicalSession(runContextCompactions, physical),
          eq(runContextCompactions.status, "in_progress"),
          lt(runContextCompactions.lastRunSequence, sequence),
        ),
      )
      .returning({ nodeAttemptId: runContextCompactions.nodeAttemptId });

    if (interrupted.length > 0) {
      const byAttempt = new Map<string | null, number>([
        [null, interrupted.length],
      ]);

      for (const { nodeAttemptId } of interrupted)
        if (nodeAttemptId !== null)
          byAttempt.set(nodeAttemptId, (byAttempt.get(nodeAttemptId) ?? 0) + 1);
      for (const [nodeAttemptId, count] of byAttempt)
        await writeCompactionCounts(tx, physical, sequence, [nodeAttemptId], {
          active: -count,
          completed: 0,
        });
    }

    return;
  }
  if (event.eventType === "session.created") {
    const attemptId =
      typeof event.payload?.nodeAttemptId === "string"
        ? event.payload.nodeAttemptId
        : null;
    const [attempt] = attemptId
      ? await tx
          .select({ id: nodeAttempts.id })
          .from(nodeAttempts)
          .where(
            and(
              eq(nodeAttempts.id, attemptId),
              eq(nodeAttempts.runId, physical.runId),
            ),
          )
      : [];

    await tx
      .insert(runContextUsage)
      .values(
        (attempt ? [null, attempt.id] : [null]).map((nodeAttemptId) => ({
          ...physical,
          nodeAttemptId,
          lastRunSequence: sequence,
          createdRunSequence: sequence,
        })),
      )
      .onConflictDoNothing();
    await tx
      .update(runContextUsage)
      .set({ createdRunSequence: sequence })
      .where(
        and(
          boundToPhysicalSession(runContextUsage, physical),
          isNull(runContextUsage.nodeAttemptId),
        ),
      );

    return;
  }
  if (
    event.eventType !== "session.update" ||
    event.payload?.contextReplay === true
  )
    return;
  const raw = event.payload?.update;

  const pruned = isPrunedContextEvent(event);
  const updateType = acpContextUpdateType(raw);

  if (!pruned && !updateType) return;
  const update = readAcpContextUpdate(event);

  if (!update && !pruned) {
    if (updateType && !warnedMalformedUpdates.has(updateType)) {
      warnedMalformedUpdates.add(updateType);
      log.warn(
        { type: updateType, sequence: String(sequence) },
        "ignored malformed ACP context observation",
      );
    }

    return;
  }
  if (update?.kind === "summary_chunk") return;
  const nodeAttemptId =
    typeof event.payload?.nodeAttemptId === "string"
      ? event.payload.nodeAttemptId
      : null;

  if (nodeAttemptId) {
    const [attempt] = await tx
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.id, nodeAttemptId),
          eq(nodeAttempts.runId, physical.runId),
        ),
      );

    if (!attempt) {
      log.warn(
        { runId: physical.runId, sequence: String(sequence) },
        "invalid context attempt attribution",
      );

      return;
    }
  }
  const observation = {
    ...physical,
    nodeAttemptId,
    sequence,
    occurredAt: event.occurredAt,
    commandId:
      typeof event.payload?.sourceCommandId === "string"
        ? event.payload.sourceCommandId
        : null,
  };

  if (pruned) {
    await writeUsage(tx, observation, null, nodeAttemptId, {
      coverageIncomplete: true,
    });
  } else if (update?.kind === "usage") {
    await projectUsage(tx, observation, {
      used: update.used,
      size: update.size,
    });
  } else if (update?.kind === "compaction") {
    await projectCompaction(tx, observation, update);
  }
}

export const canonicalContextProjector: ExecutionEventProjector = {
  consumerName: CANONICAL_PROJECTION_CONSUMERS.context,
  prepare: (db, event, signal) =>
    event.eventType === "session.update" &&
    event.payload?.contextReplay !== true &&
    (event.payload?.contextType === "usage_update" ||
      event.payload?.contextType === "compaction_update")
      ? prepareSessionContent(db, event, signal)
      : Promise.resolve(event),
  project: projectContext,
  afterCommit(events) {
    for (const event of events)
      if (isPrunedContextEvent(event))
        log.info(
          {
            runId: event.runId,
            eventId: event.id,
            type: event.payload?.contextType,
          },
          "[FIX] context observation bytes pruned",
        );
    const source = events.find(
      (event) =>
        acpContextUpdateType(event.payload?.update) ||
        event.payload?.contextType === "usage_update" ||
        event.payload?.contextType === "compaction_update" ||
        event.eventType === "session.created" ||
        event.eventType === "session.crashed" ||
        event.eventType === "session.exited",
    );

    if (source) runEventWakeBus.wake(source.runId);
  },
};
