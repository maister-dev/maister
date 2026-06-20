import "server-only";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  switchDeliveryPolicyToManual,
  type DeliveryPolicy,
} from "@/lib/runs/delivery-policy";
import { promotionFromSnapshot } from "@/lib/runs/execution-policy";
import { promoteRun } from "@/lib/runs/promote";

const { runs } = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "auto-delivery",
  level: process.env.LOG_LEVEL ?? "info",
});

async function switchRunToManual(args: {
  db: Db;
  runId: string;
  policy: DeliveryPolicy;
  reason: string;
}): Promise<void> {
  const nextPolicy = switchDeliveryPolicyToManual(args.policy);

  await args.db
    .update(runs)
    .set({ deliveryPolicySnapshot: nextPolicy })
    .where(
      and(
        eq(runs.id, args.runId),
        eq(runs.status, "Review"),
        sql`${runs.deliveryPolicySnapshot}->>'trigger' = 'auto_on_ready'`,
      ),
    );

  log.warn(
    { runId: args.runId, reason: args.reason, deliveryPolicy: nextPolicy },
    "auto delivery degraded to manual",
  );
}

export async function deliverRunIfAutoReady(
  runId: string,
  db: Db = getDb() as Db,
  promote: typeof promoteRun = promoteRun,
): Promise<void> {
  const rows = await db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      status: runs.status,
      createdByUserId: runs.createdByUserId,
      deliveryPolicySnapshot: runs.deliveryPolicySnapshot,
      executionPolicy: runs.executionPolicy,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const run = rows[0] as
    | {
        id: string;
        projectId: string;
        status: string;
        createdByUserId: string | null;
        deliveryPolicySnapshot: DeliveryPolicy | null;
        executionPolicy: unknown;
      }
    | undefined;

  // C1 (execution-policy promotion=auto_on_ready): OR-combine with the existing
  // delivery-policy trigger. Either knob auto-promotes; the delivery policy
  // still defines HOW (strategy / target). A run with no delivery snapshot but
  // an auto-promoting execution policy cannot resolve a target → stays manual.
  const autoOnReady =
    run !== undefined &&
    run.status === "Review" &&
    (run.deliveryPolicySnapshot?.trigger === "auto_on_ready" ||
      promotionFromSnapshot(run.executionPolicy) === "auto_on_ready");

  if (!run || !autoOnReady || !run.deliveryPolicySnapshot) {
    return;
  }

  if (!run.createdByUserId) {
    await switchRunToManual({
      db,
      runId,
      policy: run.deliveryPolicySnapshot,
      reason: "missing run creator",
    });

    return;
  }

  try {
    await promote(
      runId,
      {
        deliveryPolicyOverride: run.deliveryPolicySnapshot,
        targetBranch: run.deliveryPolicySnapshot.targetBranch,
        autoOnReady: true,
      },
      {
        sessionUser: { id: run.createdByUserId },
        authorize: async () => undefined,
      },
      db,
    );
  } catch (err) {
    await switchRunToManual({
      db,
      runId,
      policy: run.deliveryPolicySnapshot,
      reason: isMaisterError(err) ? err.code : "CRASH",
    });
  }
}
