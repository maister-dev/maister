import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";

import { and, eq } from "drizzle-orm";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { agentSchedules, agentTriggerAttempts, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { parseScheduledRequestSnapshot } from "@/lib/agents/scheduled-request";

export type AgentTriggerReservation = {
  attemptId: string;
  runId: string;
  flowRevisionId?: string;
};

export async function loadCronLaunchEvidence(
  db: Db,
  input: {
    agentId: string;
    projectId: string;
    reservation: AgentTriggerReservation;
  },
): Promise<{
  snapshot: ScheduledAgentRequestSnapshot | null;
  scheduleId: string;
  receipt: { runId: string; status: "Pending" | "Running" } | null;
}> {
  const [attempt] = await db
    .select()
    .from(agentTriggerAttempts)
    .where(
      and(
        eq(agentTriggerAttempts.id, input.reservation.attemptId),
        eq(agentTriggerAttempts.projectId, input.projectId),
        eq(agentTriggerAttempts.sourceAgentId, input.agentId),
      ),
    )
    .limit(1);

  if (
    !attempt ||
    attempt.triggerSource !== "cron" ||
    attempt.reservedRunId !== input.reservation.runId
  ) {
    throw new MaisterError(
      "CONFLICT",
      "Cron launch reservation does not match its invocation",
    );
  }
  const snapshot = parseScheduledRequestSnapshot(
    attempt.scheduledRequestSnapshot,
  );
  const [receipt] = await db
    .select({
      id: runs.id,
      status: runs.status,
      projectId: runs.projectId,
      agentId: runs.sourceAgentId,
      snapshot: runs.scheduledRequestSnapshot,
    })
    .from(runs)
    .where(eq(runs.id, attempt.reservedRunId))
    .limit(1);

  if (receipt) {
    if (
      receipt.projectId !== input.projectId ||
      receipt.agentId !== input.agentId ||
      canonicalCommandJson(receipt.snapshot) !==
        canonicalCommandJson(snapshot) ||
      (receipt.status !== "Pending" && receipt.status !== "Running")
    ) {
      throw new MaisterError(
        "CONFLICT",
        "Cron launch receipt conflicts with its invocation",
      );
    }

    return {
      snapshot,
      scheduleId: attempt.scheduleId,
      receipt: { runId: receipt.id, status: receipt.status },
    };
  }
  if (attempt.outcome !== null) {
    throw new MaisterError(
      "CONFLICT",
      "Settled or uncertain cron invocation cannot be redispatched",
    );
  }

  return { snapshot, scheduleId: attempt.scheduleId, receipt: null };
}

export async function liveAgentScheduleId(
  db: Db,
  input: { scheduleId: string | null; agentId: string; projectId: string },
): Promise<string | null> {
  if (input.scheduleId === null) return null;
  const [binding] = await db
    .select({ id: agentSchedules.id })
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.id, input.scheduleId),
        eq(agentSchedules.agentId, input.agentId),
        eq(agentSchedules.projectId, input.projectId),
      ),
    )
    .for("key share");

  return binding?.id ?? null;
}

export function assertScheduledRequestMatches(
  expected: ScheduledAgentRequestSnapshot | null,
  actual: ScheduledAgentRequestSnapshot | null,
): void {
  if (canonicalCommandJson(expected) !== canonicalCommandJson(actual)) {
    throw new MaisterError(
      "CONFLICT",
      "Scheduled request does not match its immutable invocation",
    );
  }
}
