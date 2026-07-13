import "server-only";

import type { TaskClarificationContext } from "@/lib/tasks/clarifications";

import { and, asc, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { hitlRequests, taskClarifications } from "@/lib/db/schema";
import {
  composeEffectivePrompt,
  deriveAwaitingClarification,
  orderedAnsweredClarifications,
  type ClarificationHistoryRow,
  type ClarificationRequestState,
} from "@/lib/tasks/clarifications";

const log = pino({
  name: "task-clarifications",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ClarificationQueryDb = Pick<ReturnType<typeof getDb>, "select">;

export type TaskClarificationHistory = ClarificationHistoryRow & {
  sourceHitlRequestId: string;
  originRunId: string;
  originAgentId: string;
  reTriggerMode: "agent" | "triage";
};

export type TaskClarificationProjection = {
  history: TaskClarificationHistory[];
  clarifications: TaskClarificationContext[];
  awaitingClarification: boolean;
  effectivePrompt: string;
};

export async function getTaskClarificationProjection(
  db: ClarificationQueryDb,
  taskId: string,
  prompt: string,
): Promise<TaskClarificationProjection> {
  const [history, requests] = await Promise.all([
    db
      .select({
        id: taskClarifications.id,
        seq: taskClarifications.seq,
        sourceHitlRequestId: taskClarifications.sourceHitlRequestId,
        originRunId: taskClarifications.originRunId,
        originAgentId: taskClarifications.originAgentId,
        question: taskClarifications.question,
        answer: taskClarifications.answer,
        answeredAt: taskClarifications.answeredAt,
        supersededAt: taskClarifications.supersededAt,
        reTriggerMode: taskClarifications.reTriggerMode,
      })
      .from(taskClarifications)
      .where(eq(taskClarifications.taskId, taskId))
      .orderBy(asc(taskClarifications.seq), asc(taskClarifications.id)),
    db
      .select({
        activationState: hitlRequests.activationState,
        respondedAt: hitlRequests.respondedAt,
        supersededAt: hitlRequests.supersededAt,
      })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.taskId, taskId),
          eq(hitlRequests.kind, "agent_question"),
        ),
      ),
  ]);

  const clarificationHistory = history as TaskClarificationHistory[];
  const clarifications = orderedAnsweredClarifications(clarificationHistory);
  const awaitingClarification = deriveAwaitingClarification(
    requests as ClarificationRequestState[],
  );

  log.debug(
    {
      taskId,
      clarificationCount: clarifications.length,
      sourceHitlRequestIds: clarificationHistory.map(
        (row) => row.sourceHitlRequestId,
      ),
      awaitingClarification,
    },
    "task clarification context assembled",
  );

  return {
    history: clarificationHistory,
    clarifications,
    awaitingClarification,
    effectivePrompt: composeEffectivePrompt(prompt, clarifications),
  };
}
