import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  createRalphRetryLaunchSource,
  loadRalphRetryLaunchScope,
} from "./ralph-launch-authority";
import { crashRetryFromSnapshot } from "./execution-policy";
import { logExecPolicyAction } from "./exec-policy-audit";

import { taskActivity, tasks, runs } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { addTaskComment } from "@/lib/social/comments";
import { lockTaskLaunchReservation } from "@/lib/tasks/launch-locks";
import { findServerTaskLaunch } from "@/lib/tasks/launch-server-source";
import {
  acceptServerTaskLaunch,
  serverTaskLaunchRequest,
} from "@/lib/tasks/launch-intent";

const log = pino({ name: "ralph-task-launch" });

type Scope = Awaited<ReturnType<typeof loadRalphRetryLaunchScope>>;

/** The source key and existing reservation lock make advisory refusal visible once without blocking manual Launch. */
async function recordQualificationRefusal(
  db: Db,
  facts: Scope,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockTaskLaunchReservation(tx, facts.task.id);
    await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, facts.task.id))
      .for("update");
    const [existing] = await tx
      .select({ id: taskActivity.id })
      .from(taskActivity)
      .where(
        and(
          eq(taskActivity.taskId, facts.task.id),
          eq(taskActivity.eventKind, "comment_added"),
          sql`${taskActivity.payload}->>'source'='ralph_retry'`,
          sql`${taskActivity.payload}->>'sourceRunId'=${facts.run.id}`,
        ),
      )
      .limit(1);

    if (existing) return;
    await addTaskComment(
      {
        taskId: facts.task.id,
        actor: { type: "system", id: null },
        body: `Automatic retry paused (${reason}). Automatic execution requires a current accepted qualification. Review triage or use a fresh manual launch.`,
        activityPayloadExtra: {
          source: "ralph_retry",
          sourceRunId: facts.run.id,
          reason,
          nextAction: "fresh_manual_launch_or_retriage",
        },
      },
      tx,
    );
  });
}

/** A failed run's policy can request one qualified automatic retry; it never renews manual authorization. */
export async function acceptRalphRetryTaskLaunch(
  db: Db,
  sourceRunId: string,
): Promise<void> {
  const [candidate] = await db
    .select({ taskId: runs.taskId, runKind: runs.runKind })
    .from(runs)
    .where(eq(runs.id, sourceRunId));

  if (!candidate?.taskId || candidate.runKind !== "flow") return;
  const facts = await loadRalphRetryLaunchScope(db, sourceRunId);

  if (
    facts.run.runKind !== "flow" ||
    facts.run.parentRunId ||
    !["Failed", "Crashed"].includes(facts.run.status) ||
    crashRetryFromSnapshot(facts.run.executionPolicy) !== "ralph_loop" ||
    ["Done", "Abandoned"].includes(facts.task.status)
  )
    return;
  try {
    let receipt = await findServerTaskLaunch(db, facts.scope, facts.requestKey);

    if (!receipt) {
      const source = await createRalphRetryLaunchSource(db, sourceRunId);
      const request = await serverTaskLaunchRequest(db, source, {
        taskId: facts.task.id,
        relaunchOfRunId: facts.run.id,
        ...(facts.run.executionPolicy
          ? { executionPolicy: facts.run.executionPolicy }
          : {}),
      });

      receipt = await acceptServerTaskLaunch(
        db,
        source,
        request,
        facts.requestKey,
      );
    }
    if (
      !receipt.runId &&
      ["held", "failed", "cancelled"].includes(receipt.state)
    ) {
      if (receipt.reason?.startsWith("qualification_"))
        await recordQualificationRefusal(db, facts, receipt.reason);
      log.info(
        {
          taskId: facts.task.id,
          sourceRunId,
          intentId: receipt.intentId,
          state: receipt.state,
          reason: receipt.reason,
        },
        "automatic retry awaits a fresh decision",
      );

      return;
    }
    logExecPolicyAction({
      runId: facts.run.id,
      kind: "ralph_relaunch",
      detail: {
        taskId: facts.task.id,
        fromRunId: facts.run.id,
        intentId: receipt.intentId,
        newRunId: receipt.runId,
        status: receipt.runStatus ?? receipt.state,
      },
    });
    log.info(
      {
        taskId: facts.task.id,
        sourceRunId,
        intentId: receipt.intentId,
        runId: receipt.runId,
        state: receipt.state,
      },
      "automatic retry intent accepted",
    );
  } catch (error) {
    const reason =
      isMaisterError(error) && typeof error.details?.reason === "string"
        ? error.details.reason
        : null;

    if (reason?.startsWith("qualification_")) {
      await recordQualificationRefusal(db, facts, reason);

      return;
    }
    throw error;
  }
}
