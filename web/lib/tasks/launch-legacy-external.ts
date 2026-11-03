import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  ExtCtx,
  ExtOperationContinuation,
} from "@/lib/tokens/ext-handler";
import type { ExternalTaskLaunchOperation } from "./launch-external";

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  externalTaskLaunchContinuation,
  externalTaskLaunchErrorResponse,
  externalTaskLaunchPrincipal,
} from "./launch-external";
import { assertTaskLaunchTokenAuthority } from "./launch-token";
import { TASK_LAUNCH_STATES } from "./launch-types";
import { launchRefusal } from "./launch-resolution";
import { wakeAcceptedTaskLaunch } from "./launch-wake";

import { runs } from "@/lib/db/schema";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { recordRequiredTokenAudit } from "@/lib/tokens/ext-handler";

const receiptProjectionSchema = z.object({
  intentId: z.string(),
  runId: z.string().nullable(),
  state: z.enum(TASK_LAUNCH_STATES),
});

/** A compatibility run id is evidence of an actual bound run, never of intent acceptance alone. */
export async function legacyExternalTaskLaunchResponse(
  db: Db,
  receipt: z.infer<typeof receiptProjectionSchema>,
): Promise<NextResponse> {
  const headers = {
    Location: `/api/v1/ext/task-launch-intents/${receipt.intentId}`,
    "Cache-Control": "no-store",
  };

  if (receipt.runId === null) {
    return NextResponse.json(
      {
        accepted: true,
        code: "launch_pending",
        intentId: receipt.intentId,
        state: receipt.state,
      },
      { status: 202, headers },
    );
  }
  const [run] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.id, receipt.runId),
        eq(runs.taskLaunchIntentId, receipt.intentId),
      ),
    );

  if (!run) throw launchRefusal("launch_state_changed");

  return NextResponse.json(
    { runId: run.id, status: run.status, intentId: receipt.intentId },
    { status: 202, headers },
  );
}

export function legacyExternalTaskLaunchContinuation(
  db: Db,
  request: Request,
  contract: ExternalTaskLaunchOperation,
  work: (context: ExtCtx) => Promise<NextResponse>,
): ExtOperationContinuation {
  const continuation = externalTaskLaunchContinuation(
    db,
    request,
    contract,
    work,
    (receipt) => wakeAcceptedTaskLaunch(db, receipt),
  );

  return {
    replay: async (operation, context) => {
      const historical = operation.result?.body;

      if (
        operation.status === "succeeded" &&
        operation.result?.statusCode === 202 &&
        typeof historical?.runId === "string" &&
        typeof historical.intentId !== "string"
      ) {
        try {
          const principal = await externalTaskLaunchPrincipal(
            db,
            request,
            context,
          );

          await db.transaction(async (tx) => {
            await assertTaskLaunchTokenAuthority(
              tx,
              principal,
              context.projectId,
              ["launchRun"],
            );
            await recordRequiredTokenAudit(
              {
                ...tokenAuditIdentity(context.actor),
                projectId: context.projectId,
                scopeUsed: "runs:launch",
                endpoint: contract.endpoint,
                method: "POST",
                result: "ok",
                statusCode: 202,
                operationId: context.operationId,
              },
              tx,
            );
          });

          return NextResponse.json(historical, {
            status: 202,
            headers: { "Cache-Control": "no-store" },
          });
        } catch (error) {
          return externalTaskLaunchErrorResponse(error);
        }
      }
      const response = await continuation.replay(operation, context);

      if (!response.ok || operation.status !== "succeeded") return response;
      try {
        const receipt = receiptProjectionSchema.parse(await response.json());

        return await legacyExternalTaskLaunchResponse(db, receipt);
      } catch (error) {
        return externalTaskLaunchErrorResponse(error);
      }
    },
    refuse: continuation.refuse,
  };
}
