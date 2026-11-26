import "server-only";

import type { Db } from "./db";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  executionAssignments,
  executionHostLosses,
  executionHosts,
  runs,
  taskLaunchIntents,
  users,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  ABANDONABLE_STATUSES,
  abandonRunInTransaction,
} from "@/lib/runs/state-transitions";
import { takeSchedulerLock } from "@/lib/scheduler";
import { emitTaskLaunchChanged } from "@/lib/tasks/launch-events";
import { declareExecutionHostRegistryWriter, lockHostByKey } from "./hosts";
import { EXECUTION_HOST_PERMANENTLY_LOST } from "./types";
import { EXECUTION_HOST_KEY_PATTERN } from "../../../runtime/execution-host-address";

const log = pino({ name: "execution-host-loss" });

export const executionHostLossSchema = z.strictObject({
  hostKey: z.string().regex(EXECUTION_HOST_KEY_PATTERN),
  observedBootId: z.string().uuid(),
  operatorId: z.string().min(1).max(256),
  isolationEvidenceRef: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/u),
});

type LossRequest = z.infer<typeof executionHostLossSchema>;
type LossResult = Readonly<{
  executionHostId: string;
  abandonedRuns: readonly string[];
  heldIntents: readonly string[];
  replayed: boolean;
}>;

/** Record an operator's external isolation decision. Retain all physical obligations. */
export async function declareExecutionHostLoss(
  db: Db,
  request: LossRequest,
): Promise<LossResult> {
  const parsed = executionHostLossSchema.safeParse(request);
  if (!parsed.success)
    throw new MaisterError("PRECONDITION", "Invalid host isolation evidence");

  const { hostKey, observedBootId, operatorId, isolationEvidenceRef } =
    parsed.data;
  const result = await db.transaction(async (tx): Promise<LossResult> => {
    await takeSchedulerLock(tx);
    const [operator] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, operatorId),
          eq(users.role, "admin"),
          eq(users.accountStatus, "active"),
        ),
      )
      .for("share");
    if (!operator)
      throw new MaisterError(
        "UNAUTHORIZED",
        "An active global administrator must record host isolation",
      );

    const host = await lockHostByKey(tx, hostKey);
    if (
      !host ||
      host.lastBootId !== observedBootId ||
      !Array.isArray(host.capabilities.workspaceProtocol)
    )
      throw new MaisterError(
        "CONFLICT",
        "The observed addressed host or boot changed",
      );
    const [existing] = await tx
      .select()
      .from(executionHostLosses)
      .where(eq(executionHostLosses.executionHostId, host.id));
    if (existing) {
      if (
        existing.isolationEvidenceRef !== isolationEvidenceRef ||
        existing.operatorId !== operatorId
      )
        throw new MaisterError(
          "CONFLICT",
          "This host already has a permanent loss record",
        );

      return {
        executionHostId: host.id,
        abandonedRuns: [],
        heldIntents: [],
        replayed: true,
      };
    }
    if (host.readiness !== "unavailable" && host.retiredAt === null)
      throw new MaisterError(
        "PRECONDITION",
        "The supervisor is still registered as available",
      );

    const now = new Date();
    await declareExecutionHostRegistryWriter(tx);
    await tx
      .update(executionHosts)
      .set({
        readiness: "unavailable",
        readinessReason: EXECUTION_HOST_PERMANENTLY_LOST,
        retiredAt: host.retiredAt ?? now,
        updatedAt: now,
      })
      .where(eq(executionHosts.id, host.id));
    await tx.insert(executionHostLosses).values({
      executionHostId: host.id,
      hostKey,
      observedBootId,
      operatorId,
      isolationEvidenceRef,
      recordedAt: now,
    });

    const occupied = await tx
      .select({ id: runs.id })
      .from(runs)
      .leftJoin(
        executionAssignments,
        eq(executionAssignments.id, runs.executionAssignmentId),
      )
      .where(
        and(
          inArray(runs.status, [...ABANDONABLE_STATUSES, "HumanWorking"]),
          or(
            eq(executionAssignments.executionHostId, host.id),
            sql`${runs.executionAssignmentId} IS NULL AND EXISTS (SELECT 1 FROM ${workspaces} w WHERE w.run_id=${runs.id}
          AND w.execution_host_id=${host.id} AND w.ownership_kind='host_owned' AND w.removed_at IS NULL)`,
          ),
        ),
      )
      .orderBy(asc(runs.id))
      .for("update", { of: runs });
    const abandonedRuns: string[] = [];
    for (const { id } of occupied)
      if (
        await abandonRunInTransaction(tx, id, {
          code: "EXECUTOR_UNAVAILABLE",
          reason: EXECUTION_HOST_PERMANENTLY_LOST,
          source: "operator",
        })
      )
        abandonedRuns.push(id);

    const held = await tx
      .update(taskLaunchIntents)
      .set({
        state: "held",
        reason: EXECUTION_HOST_PERMANENTLY_LOST,
        stateVersion: sql`${taskLaunchIntents.stateVersion} + 1`,
        leaseToken: null,
        leaseExpiresAt: null,
        dueAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskLaunchIntents.effectiveExecutionHostId, host.id),
          inArray(taskLaunchIntents.state, ["queued", "preparing"]),
          isNull(taskLaunchIntents.runId),
        ),
      )
      .returning();
    for (const intent of held)
      await emitTaskLaunchChanged(tx, intent, { type: "user", id: operatorId });

    return {
      executionHostId: host.id,
      abandonedRuns,
      heldIntents: held.map(({ id }) => id),
      replayed: false,
    };
  });
  log.warn(
    { hostKey, observedBootId, operatorId, isolationEvidenceRef, ...result },
    "execution-host-permanent-loss-recorded",
  );

  return result;
}
