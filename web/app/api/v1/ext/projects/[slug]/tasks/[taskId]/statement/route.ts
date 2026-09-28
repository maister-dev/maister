import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { librarianTurns } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { taskStatementSchema, acceptStatement } from "@/lib/tasks/statement";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { socialActorForToken } from "@/lib/tokens/verify";

const ENDPOINT = "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/statement";

const bodySchema = z.object({
  statement: taskStatementSchema,
  expectedRevision: z.number().int().nonnegative(),
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
    scopeLabel: "tasks:update",
    endpoint: ENDPOINT,
    method: "POST",
    admitLibrarian: true,
    successAuditInWork: true,
    idempotency: {
      kind: "task_statement_accept",
      target: { slug, taskId },
      parseBody: async (request) => bodySchema.parse(await request.json()),
    },
    db,
  }, async (ctx) => {
    if (ctx.actor.tokenKind !== "librarian" || !ctx.actor.librarianTurnId || !ctx.operationId) {
      return NextResponse.json({ code: "UNAUTHORIZED", message: "a librarian turn is required" }, { status: 403 });
    }

    const turn = await db.query.librarianTurns.findFirst({
      where: eq(librarianTurns.id, ctx.actor.librarianTurnId),
      columns: { conversationId: true, messageId: true },
    });

    if (!turn) {
      return NextResponse.json({ code: "PRECONDITION", message: "librarian turn not found" }, { status: 409 });
    }

    let body: z.infer<typeof bodySchema>;

    try {
      body = bodySchema.parse(await req.json());
    } catch (err) {
      return NextResponse.json({ code: "CONFIG", message: `invalid body: ${(err as Error).message}` }, { status: 422 });
    }

    try {
      const result = await db.transaction(async (tx) => {
        const accepted = await acceptStatement({
          projectId: ctx.projectId,
          taskId,
          conversationId: turn.conversationId,
          statement: body.statement,
          expectedRevision: body.expectedRevision,
          actor: socialActorForToken(ctx.actor),
          viaOperationId: ctx.operationId,
          fromMessageId: turn.messageId,
          toMessageId: turn.messageId,
        }, tx as unknown as ReturnType<typeof getDb>);

        await recordRequiredTokenAudit({
          ...tokenAuditIdentity(ctx.actor),
          projectId: ctx.projectId,
          scopeUsed: "tasks:update",
          endpoint: ENDPOINT,
          method: "POST",
          result: "ok",
          statusCode: 200,
          operationId: ctx.operationId,
          operation: { id: ctx.operationId!, result: { statusCode: 200, body: accepted } },
        }, tx);

        return accepted;
      });

      return NextResponse.json(result);
    } catch (err) {
      if (!isMaisterError(err)) throw err;

      return NextResponse.json({ code: err.code, message: err.message, details: err.details }, {
        status: httpStatusForExtCode(err.code),
      });
    }
  });
}
