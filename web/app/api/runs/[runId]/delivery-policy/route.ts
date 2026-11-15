import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  switchDeliveryPolicyToManual,
  type DeliveryPolicy,
} from "@/lib/runs/delivery-policy";

const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-run-delivery-policy",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

const patchBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("switch_to_manual") }).strict(),
  // ADR-207: whether a confirmed merge of this Run's PR may complete its task.
  z
    .object({
      action: z.literal("set_task_resolution"),
      resolvesTask: z.boolean(),
    })
    .strict(),
]);

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message, details: err.details },
      { status: httpStatusForCode(err.code) },
    );
  }

  log.error(
    { runId, err: err instanceof Error ? err.message : String(err) },
    "run delivery policy API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// The flag rendered into a PR body (closing reference) must never change after
// delivery starts; the run row lock serializes it against a concurrent promote.
async function setTaskResolution(
  runId: string,
  resolvesTask: boolean,
): Promise<DeliveryPolicy> {
  const db = getDb() as any;

  return db.transaction(async (tx: any) => {
    const [run] = await tx
      .select({
        taskId: runs.taskId,
        deliveryPolicySnapshot: runs.deliveryPolicySnapshot,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");

    if (!run.taskId) {
      throw new MaisterError("PRECONDITION", "run has no task to resolve", {
        details: { reason: "run_has_no_task" },
      });
    }

    const [workspace] = await tx
      .select({
        promotionState: workspaces.promotionState,
        prNumber: workspaces.prNumber,
      })
      .from(workspaces)
      .where(eq(workspaces.runId, runId));

    if (
      workspace &&
      (workspace.promotionState === "claiming" ||
        workspace.promotionState === "done" ||
        workspace.prNumber !== null)
    ) {
      throw new MaisterError(
        "CONFLICT",
        "delivery already started; task resolution is frozen",
        { details: { reason: "delivery_already_started" } },
      );
    }

    const deliveryPolicy = {
      ...(run.deliveryPolicySnapshot as DeliveryPolicy),
      resolvesTask,
    };

    await tx
      .update(runs)
      .set({ deliveryPolicySnapshot: deliveryPolicy })
      .where(eq(runs.id, runId));
    log.info({ runId, resolvesTask }, "run task resolution recorded");

    return deliveryPolicy;
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    let body: z.infer<typeof patchBodySchema>;

    try {
      body = patchBodySchema.parse(await req.json());
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await requireActiveSession();

    const db = getDb() as any;
    const rows = await db
      .select({
        id: runs.id,
        projectId: runs.projectId,
        status: runs.status,
        deliveryPolicySnapshot: runs.deliveryPolicySnapshot,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    const row = rows[0] as
      | {
          id: string;
          projectId: string;
          status: string;
          deliveryPolicySnapshot: DeliveryPolicy | null;
        }
      | undefined;

    if (!row) {
      throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
    }

    await requireProjectAction(row.projectId, "promoteRun");

    if (body.action === "set_task_resolution") {
      const deliveryPolicy = await setTaskResolution(runId, body.resolvesTask);

      return NextResponse.json({ ok: true, runId, deliveryPolicy });
    }

    if (
      row.status !== "Review" ||
      row.deliveryPolicySnapshot?.trigger !== "auto_on_ready"
    ) {
      throw new MaisterError(
        "CONFLICT",
        `run ${runId} is not waiting for auto delivery cancellation`,
      );
    }

    const nextPolicy = switchDeliveryPolicyToManual(row.deliveryPolicySnapshot);
    const updated = await db
      .update(runs)
      .set({ deliveryPolicySnapshot: nextPolicy })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.status, "Review"),
          sql`${runs.deliveryPolicySnapshot}->>'trigger' = 'auto_on_ready'`,
        ),
      )
      .returning({ id: runs.id });

    if (updated.length === 0) {
      throw new MaisterError(
        "CONFLICT",
        `run ${runId} delivery policy changed before cancellation`,
      );
    }

    log.info(
      { runId, projectId: row.projectId, deliveryPolicy: nextPolicy },
      "run delivery policy switched to manual",
    );

    return NextResponse.json({ ok: true, runId, deliveryPolicy: nextPolicy });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
