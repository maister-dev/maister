import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { projects, tasks } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { sendTaskToTriageInTransaction } from "@/lib/services/triage";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { socialActorForToken } from "@/lib/tokens/verify";

const ENDPOINT = "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/send-to-triage";
const bodySchema = z.object({
  launchIntent: z.enum(["triage_only", "triage_then_launch"]),
}).strict();

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(req, {
    slug,
    scopeLabel: "tasks:triage",
    endpoint: ENDPOINT,
    method: "POST",
    admitLibrarian: true,
    successAuditInWork: true,
    idempotency: {
      kind: "task_send_to_triage",
      target: { slug, taskId },
      parseBody: async (request) => bodySchema.parse(await request.json()),
    },
    db,
  }, async (ctx) => {
    let body: z.infer<typeof bodySchema>;

    try {
      body = bodySchema.parse(await req.json());
    } catch (err) {
      return NextResponse.json({ code: "CONFIG", message: `invalid body: ${(err as Error).message}` }, { status: 422 });
    }

    try {
      const receipt = await db.transaction(async (tx) => {
        const rows = await tx.select({
          id: tasks.id,
          title: tasks.title,
          number: tasks.number,
          taskKey: projects.taskKey,
        }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(
          and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)),
        ).for("update", { of: tasks });

        if (rows.length === 0) {
          return null;
        }

        const task = rows[0];

        await sendTaskToTriageInTransaction(tx, {
          taskId,
          projectId: ctx.projectId,
          taskRef: `${task.taskKey}-${task.number}`,
          title: task.title,
          actor: socialActorForToken(ctx.actor),
          launchIntent: body.launchIntent,
        });

        const result = { ok: true, taskId, launchIntent: body.launchIntent, triageStatus: null };

        await recordRequiredTokenAudit({
          ...tokenAuditIdentity(ctx.actor),
          projectId: ctx.projectId,
          scopeUsed: "tasks:triage",
          endpoint: ENDPOINT,
          method: "POST",
          result: "ok",
          statusCode: 200,
          operationId: ctx.operationId,
          operation: ctx.operationId
            ? { id: ctx.operationId, result: { statusCode: 200, body: result } }
            : undefined,
        }, tx);

        return result;
      });

      return receipt
        ? NextResponse.json(receipt)
        : NextResponse.json({ code: "NOT_FOUND", message: "task not found" }, { status: 404 });
    } catch (err) {
      if (!isMaisterError(err)) throw err;

      return NextResponse.json({ code: err.code, message: err.message, details: err.details }, {
        status: httpStatusForExtCode(err.code),
      });
    }
  });
}
