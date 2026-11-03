import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchRequest } from "./launch-schema";
import type {
  TaskLaunchServerSource,
  TaskLaunchServerSourceSnapshot,
} from "./launch-server-source";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { createTaskLaunchServerSource } from "./launch-server-source";
import {
  budgetRestartDecisionRequired,
  readBudgetRestartLaunch,
} from "./launch-budget-restart";

import { hitlRequests, runs } from "@/lib/db/schema";
import { retryDigest } from "@/lib/agents/retry-guards";

const payloadSchema = z
  .object({
    kind: z.literal("budget_restart"),
    oldRunId: z.string().min(1),
    hitlRequestId: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();

/** The existing durable HITL claim owns these extras; client payload cannot construct this capability. */
export async function createBudgetRestartLaunchSource(
  db: Db,
  request: TaskLaunchRequest,
  hitlRequestId: string,
): Promise<TaskLaunchServerSource> {
  if (!request.relaunchOfRunId) throw budgetRestartDecisionRequired();
  const [source] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, request.relaunchOfRunId));

  if (
    !source?.projectId ||
    source.taskId !== request.taskId ||
    (source.runKind === "agent" &&
      (!source.agentId ||
        !source.agentWorkspace ||
        source.agentKind === "operational" ||
        !["manual", "cron", "domain_event", "webhook", "flow"].includes(
          source.triggerSource ?? "",
        )))
  )
    throw budgetRestartDecisionRequired();

  return createTaskLaunchServerSource(
    db,
    {
      version: 1,
      kind: "budget_restart",
      id: hitlRequestId,
      projectId: source.projectId,
      taskId: request.taskId,
      revisionDigest: retryDigest(request),
      ...(source.runKind === "agent" && source.agentWorkspace
        ? { agentWorkspace: source.agentWorkspace }
        : {}),
      execution: {
        ...(source.runKind === "agent" && source.agentId
          ? { agentId: source.agentId }
          : {}),
        triggerSource:
          source.runKind === "agent"
            ? (source.triggerSource as
                "manual" | "cron" | "domain_event" | "webhook" | "flow")
            : "manual",
        ...(source.runKind === "agent"
          ? { triggerEventId: source.triggerEventId }
          : {}),
        triggerPayload: {
          kind: "budget_restart",
          oldRunId: source.id,
          hitlRequestId,
          idempotencyKey: `budget_restart:${source.id}:${hitlRequestId}`,
        },
      },
    },
    assertStoredBudgetRestartLaunchSource,
  );
}

export async function assertStoredBudgetRestartLaunchSource(
  db: Db,
  snapshot: TaskLaunchServerSourceSnapshot,
): Promise<void> {
  const payload = payloadSchema.safeParse(snapshot.execution.triggerPayload);

  if (
    snapshot.kind !== "budget_restart" ||
    !payload.success ||
    snapshot.id !== payload.data.hitlRequestId ||
    payload.data.idempotencyKey !==
      `budget_restart:${payload.data.oldRunId}:${payload.data.hitlRequestId}`
  )
    throw budgetRestartDecisionRequired();
  const [source] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, payload.data.oldRunId),
        eq(runs.projectId, snapshot.projectId),
        eq(runs.taskId, snapshot.taskId),
      ),
    );
  const [gate] = await db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.id, payload.data.hitlRequestId),
        eq(hitlRequests.runId, payload.data.oldRunId),
      ),
    );
  const claim = gate?.response as {
    optionId?: string;
    stage?: string;
    restartLaunch?: unknown;
  } | null;

  if (
    !source ||
    snapshot.execution.triggerSource !==
      (source.runKind === "agent" ? source.triggerSource : "manual") ||
    (source.runKind === "agent" &&
      (snapshot.agentWorkspace !== source.agentWorkspace ||
        snapshot.execution.triggerEventId !== source.triggerEventId ||
        source.agentKind === "operational")) ||
    !gate ||
    gate.kind !== "budget_breach" ||
    !["NeedsInput", "NeedsInputIdle", "Failed"].includes(source.status) ||
    claim?.optionId !== "restart" ||
    !["claimed", "terminalized"].includes(claim.stage ?? "")
  )
    throw budgetRestartDecisionRequired();
  const request = readBudgetRestartLaunch(claim.restartLaunch);

  if (
    request.taskId !== snapshot.taskId ||
    request.relaunchOfRunId !== source.id ||
    (source.runKind === "agent"
      ? !source.agentId ||
        request.agentId !== source.agentId ||
        request.workspace !== source.agentWorkspace ||
        snapshot.execution.agentId !== source.agentId
      : Boolean(request.agentId || snapshot.execution.agentId)) ||
    retryDigest(request) !== snapshot.revisionDigest
  )
    throw budgetRestartDecisionRequired();
}
