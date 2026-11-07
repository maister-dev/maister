import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { InteractiveTaskLaunchPrincipal } from "./admission-types";

import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { assertInteractiveTaskLaunchPrincipal } from "./admission-types";
import {
  assertTaskLaunchReadAuthority,
  assertTaskLaunchUserAuthority,
} from "./launch-authority";
import { launchRefusal } from "./launch-resolution";
import { isManualTriageHold } from "./manual-launch-hold";

import { tasks } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { recordTaskActivity } from "@/lib/social/activity";

const log = pino({ name: "task-launch-hold" });

export const resolveTaskLaunchHoldSchema = z
  .object({
    taskId: z.uuid(),
    expectedRevision: z.number().int().min(0).max(2_147_483_647),
    expectedOrigin: z.enum(["explicit", "dispatch_failure", "unknown"]),
  })
  .strict();

export type ResolveTaskLaunchHoldRequest = z.infer<
  typeof resolveTaskLaunchHoldSchema
>;
export type ResolvedTaskLaunchHold = Readonly<{
  taskId: string;
  revision: number;
  triageStatus: null;
  triageFlagOrigin: null;
}>;

/** A fresh human decision clears an independent hold without granting execution authority. */
export async function resolveTaskLaunchHold(
  db: Db,
  principal: InteractiveTaskLaunchPrincipal,
  request: ResolveTaskLaunchHoldRequest,
): Promise<ResolvedTaskLaunchHold> {
  assertInteractiveTaskLaunchPrincipal(principal);

  return db.transaction(async (tx) => {
    const [navigation] = await tx
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, request.taskId));

    if (!navigation) throw launchRefusal("launch_not_found", "PRECONDITION");
    try {
      await assertTaskLaunchReadAuthority(
        tx,
        navigation.projectId,
        principal.userId,
      );
    } catch (error) {
      if (isMaisterError(error) && error.code === "UNAUTHORIZED")
        throw launchRefusal("launch_not_found", "PRECONDITION");
      throw error;
    }
    await assertTaskLaunchUserAuthority(
      tx,
      navigation.projectId,
      principal.userId,
      ["editTask"],
    );
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, request.taskId))
      .for("update");

    if (
      !task ||
      task.revision !== request.expectedRevision ||
      task.triageFlagOrigin !== request.expectedOrigin ||
      !isManualTriageHold(task)
    )
      throw launchRefusal("launch_hold_changed");
    const [updated] = await tx
      .update(tasks)
      .set({
        triageStatus: null,
        triageFlagOrigin: null,
        revision: sql`${tasks.revision}+1`,
        launchMode: null,
        launchArmedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id))
      .returning({ revision: tasks.revision });

    await recordTaskActivity(tx, {
      taskId: task.id,
      projectId: task.projectId,
      actor: { type: "user", id: principal.userId },
      eventKind: "triage_set",
      payload: { flag: false, previousOrigin: task.triageFlagOrigin },
    });
    log.info(
      {
        taskId: task.id,
        userId: principal.userId,
        previousOrigin: task.triageFlagOrigin,
        revision: updated.revision,
      },
      "task-launch-hold-resolved",
    );

    return {
      taskId: task.id,
      revision: updated.revision,
      triageStatus: null,
      triageFlagOrigin: null,
    };
  });
}
