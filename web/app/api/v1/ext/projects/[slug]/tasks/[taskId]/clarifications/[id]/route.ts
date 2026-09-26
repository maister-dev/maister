import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { tasks } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { cancelClarification } from "@/lib/tasks/clarification-requests";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

const ENDPOINT =
  "DELETE /api/v1/ext/projects/[slug]/tasks/[taskId]/clarifications/[id]";

type RouteParams = {
  params: Promise<{ slug: string; taskId: string; id: string }>;
};

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId, id } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "hitl:request",
      endpoint: ENDPOINT,
      method: "DELETE",
      admitLibrarian: true,
      successAuditInWork: true,
      idempotency: {
        kind: "clarification_cancel",
        target: { slug, taskId, clarificationId: id },
        parseBody: async () => ({}),
      },
      db,
    },
    async (ctx) => {
      if (
        ctx.actor.tokenKind !== "librarian" ||
        !ctx.actor.ownerUserId ||
        !ctx.operationId
      ) {
        return NextResponse.json(
          { code: "UNAUTHORIZED", message: "a librarian turn is required" },
          { status: 403 },
        );
      }
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)));

      if (!task)
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );

      try {
        const receipt = await cancelClarification(
          {
            taskId,
            clarificationId: id,
            actorUserId: ctx.actor.ownerUserId,
            recordCancelled: async (tx, cancelled) => {
              await recordRequiredTokenAudit(
                {
                  ...tokenAuditIdentity(ctx.actor),
                  projectId: ctx.projectId,
                  scopeUsed: "hitl:request",
                  endpoint: ENDPOINT,
                  method: "DELETE",
                  result: "ok",
                  statusCode: 200,
                  operationId: ctx.operationId,
                  operation: {
                    id: ctx.operationId!,
                    result: { statusCode: 200, body: cancelled },
                  },
                },
                tx,
              );
            },
          },
          db,
        );

        return NextResponse.json(receipt);
      } catch (err) {
        if (!isMaisterError(err)) throw err;

        return NextResponse.json(
          { code: err.code, message: err.message, details: err.details },
          {
            status: httpStatusForExtCode(err.code),
          },
        );
      }
    },
  );
}
