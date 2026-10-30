import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentTriggerAttemptOutcome } from "@/lib/agents/trigger-attempt-types";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import pino from "pino";

import { agentSchedules, agentTriggerAttempts, runs } from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import {
  recordAgentIncident,
  resolveAgentAdmissionIncident,
} from "@/lib/runs/agent-incidents";

const log = pino({
  name: "agent-trigger-attempts",
  level: process.env.LOG_LEVEL ?? "info",
});
const RECOVERY_GRACE_MS = 300_000;

export type AgentTriggerClaim = typeof agentTriggerAttempts.$inferSelect;

async function insertClaim(
  tx: Db,
  binding: typeof agentSchedules.$inferSelect,
  now: Date,
  deliveryKey: string,
  eventId: number | null,
): Promise<AgentTriggerClaim> {
  const [attempt] = await tx
    .insert(agentTriggerAttempts)
    .values({
      projectId: binding.projectId,
      sourceAgentId: binding.agentId,
      scheduleId: binding.id,
      bindingSnapshot: {
        version: 1,
        scheduleId: binding.id,
        triggerType: binding.triggerType,
        cronExpr: binding.cronExpr,
        timezone: binding.timezone,
        eventKinds: binding.eventMatch?.kinds ?? [],
      },
      fence: binding.lastAttemptFence!,
      deliveryKey,
      triggerSource: binding.triggerType === "cron" ? "cron" : "domain_event",
      triggerEventId: eventId,
      reservedRunId: randomUUID(),
      claimedAt: now,
      dueAt: new Date(now.getTime() + RECOVERY_GRACE_MS),
    })
    .returning();

  log.debug(
    { attemptId: attempt.id, scheduleId: binding.id, fence: attempt.fence },
    "agent-trigger-attempt-claimed",
  );

  return attempt;
}

export async function claimCronAgentAttempt(
  db: Db,
  scheduleId: string,
  now: Date,
  next: Date,
): Promise<AgentTriggerClaim | null> {
  return db.transaction(async (tx) => {
    const [binding] = await tx
      .update(agentSchedules)
      .set({
        nextFireAt: next,
        lastFiredAt: now,
        lastAttemptAt: now,
        lastAttemptFence: sql`COALESCE(${agentSchedules.lastAttemptFence}, 0) + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentSchedules.id, scheduleId),
          eq(agentSchedules.enabled, true),
          lte(agentSchedules.nextFireAt, now),
        ),
      )
      .returning();

    if (!binding) return null;

    return insertClaim(
      tx,
      binding,
      now,
      `cron:${binding.lastAttemptFence}`,
      null,
    );
  });
}

export async function claimEventAgentAttempt(
  db: Db,
  scheduleId: string,
  now: Date,
  eventId: number,
): Promise<AgentTriggerClaim | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.id, scheduleId),
          eq(agentSchedules.enabled, true),
        ),
      )
      .for("update");

    if (!current) return null;
    const deliveryKey = `event:${eventId}`;
    const [existing] = await tx
      .select()
      .from(agentTriggerAttempts)
      .where(
        and(
          eq(agentTriggerAttempts.scheduleId, scheduleId),
          eq(agentTriggerAttempts.deliveryKey, deliveryKey),
        ),
      )
      .limit(1);

    if (existing) {
      if (
        existing.outcome === "launched" ||
        existing.outcome === "queued" ||
        existing.outcome === "deduplicated"
      ) {
        await tx
          .update(agentSchedules)
          .set({ lastOutcome: "deduplicated", updatedAt: now })
          .where(
            and(
              eq(agentSchedules.id, scheduleId),
              eq(agentSchedules.lastAttemptFence, existing.fence),
            ),
          );
      }

      return null;
    }
    const [binding] = await tx
      .update(agentSchedules)
      .set({
        lastAttemptAt: now,
        lastAttemptFence: sql`COALESCE(${agentSchedules.lastAttemptFence}, 0) + 1`,
        updatedAt: now,
      })
      .where(eq(agentSchedules.id, scheduleId))
      .returning();

    return insertClaim(tx, binding, now, deliveryKey, eventId);
  });
}

export async function settleAgentTriggerAttempt(
  db: Db,
  attempt: AgentTriggerClaim,
  input: {
    outcome: AgentTriggerAttemptOutcome;
    runId: string | null;
    reasonCode: string | null;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    // A run receipt is read before the attempt lock, matching source-run -> agent lock order.
    const [run] = await tx
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          eq(runs.id, input.runId ?? attempt.reservedRunId),
          eq(runs.projectId, attempt.projectId),
          sql`COALESCE(${runs.sourceAgentId}, ${runs.agentId}) = ${attempt.sourceAgentId}`,
        ),
      )
      .for("update");
    const settlement =
      run && input.runId === null
        ? {
            ...input,
            runId: run.id,
            reasonCode: null,
            outcome:
              run.status === "Pending"
                ? ("queued" as const)
                : ("launched" as const),
          }
        : input;
    const [settled] = await tx
      .update(agentTriggerAttempts)
      .set({
        outcome: settlement.outcome,
        runId: run?.id ?? null,
        originalRunId: settlement.runId,
        settledAt: settlement.now,
        reasonCode: settlement.reasonCode,
        dueAt: new Date(settlement.now.getTime() + RECOVERY_GRACE_MS),
      })
      .where(
        and(
          eq(agentTriggerAttempts.id, attempt.id),
          eq(agentTriggerAttempts.fence, attempt.fence),
          or(
            isNull(agentTriggerAttempts.outcome),
            and(
              eq(agentTriggerAttempts.outcome, "unknown"),
              sql`${settlement.runId}::text IS NOT NULL`,
            ),
          ),
        ),
      )
      .returning();

    if (!settled) return;
    await tx
      .update(agentSchedules)
      .set({
        lastOutcome:
          settlement.outcome === "unknown" ? "failed" : settlement.outcome,
        lastRunId: settlement.runId,
        lastErrorCode: settlement.reasonCode,
        lastErrorMessage: settlement.reasonCode
          ? "Agent trigger requires attention"
          : null,
        updatedAt: settlement.now,
      })
      .where(
        and(
          eq(agentSchedules.id, attempt.scheduleId),
          eq(agentSchedules.lastAttemptFence, attempt.fence),
        ),
      );
    if (run)
      await resolveAgentAdmissionIncident(
        tx,
        attempt.projectId,
        attempt.sourceAgentId,
        attempt.id,
        settlement.now,
      );
    if (
      settlement.outcome === "refused" ||
      settlement.outcome === "failed" ||
      settlement.outcome === "unknown"
    ) {
      const reasonCode =
        settlement.outcome === "unknown"
          ? "external_effects_unknown"
          : (settlement.reasonCode ?? "agent_admission_refused");

      await recordAgentIncident(tx, {
        projectId: attempt.projectId,
        agentId: attempt.sourceAgentId,
        sourceFactKey: `attempt:${attempt.id}`,
        scopeKey: attempt.scopeKey,
        scopeKind: "unknown",
        fingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              version: 1,
              channel: "admission_refusal",
              reasonCode,
            }),
          )
          .digest("hex"),
        reasonCode,
        runId: null,
        channel: "admission_refusal",
        observedAt: settlement.now,
      });
    }
    await emitDomainEvent({
      db: tx,
      kind: "agent.activity_changed",
      projectId: attempt.projectId,
      payload: {
        projectId: attempt.projectId,
        agentId: attempt.sourceAgentId,
        revision: attempt.fence,
      },
    });
    log.info(
      {
        attemptId: attempt.id,
        fence: attempt.fence,
        outcome: settlement.outcome,
        runId: settlement.runId,
        reasonCode: settlement.reasonCode,
      },
      "agent-trigger-attempt-settled",
    );
  });
}

/** Adopt a persisted launch receipt; never redispatch an uncertain external operation. */
export async function reconcileAgentTriggerAttempts(
  db: Db,
  now: Date,
): Promise<{ adopted: number; unknown: number }> {
  const due = await db
    .select()
    .from(agentTriggerAttempts)
    .where(
      and(
        lte(agentTriggerAttempts.dueAt, now),
        or(
          isNull(agentTriggerAttempts.outcome),
          eq(agentTriggerAttempts.outcome, "unknown"),
        ),
      ),
    )
    .orderBy(agentTriggerAttempts.dueAt, agentTriggerAttempts.id)
    .limit(25);
  const result = { adopted: 0, unknown: 0 };

  for (const attempt of due) {
    const [run] = await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, attempt.projectId),
          sql`COALESCE(${runs.sourceAgentId}, ${runs.agentId}) = ${attempt.sourceAgentId}`,
          or(
            eq(runs.id, attempt.reservedRunId),
            attempt.triggerEventId === null
              ? sql`false`
              : and(
                  eq(runs.agentId, attempt.sourceAgentId),
                  eq(runs.triggerEventId, attempt.triggerEventId),
                ),
          ),
        ),
      )
      .limit(1);

    if (run) {
      await settleAgentTriggerAttempt(db, attempt, {
        outcome: run.status === "Pending" ? "queued" : "launched",
        runId: run.id,
        reasonCode: null,
        now,
      });
      result.adopted++;
    } else if (attempt.outcome === null) {
      await settleAgentTriggerAttempt(db, attempt, {
        outcome: "unknown",
        runId: null,
        reasonCode: "agent_trigger_outcome_unknown",
        now,
      });
      result.unknown++;
    } else {
      await db
        .update(agentTriggerAttempts)
        .set({ dueAt: new Date(now.getTime() + RECOVERY_GRACE_MS) })
        .where(
          and(
            eq(agentTriggerAttempts.id, attempt.id),
            eq(agentTriggerAttempts.outcome, "unknown"),
          ),
        );
    }
  }

  return result;
}
