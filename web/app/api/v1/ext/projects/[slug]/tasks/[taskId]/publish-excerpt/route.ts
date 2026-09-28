import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { librarianTaskLinks, librarianTurns, tasks } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { addTaskComment, toCommentDTOs } from "@/lib/social/comments";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import { handleExt, httpStatusForExtCode, recordRequiredTokenAudit } from "@/lib/tokens/ext-handler";
import { socialActorForToken } from "@/lib/tokens/verify";

const ENDPOINT = "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/publish-excerpt";
const bodySchema = z.object({ excerpt: z.string().min(1).max(5000) }).strict();
type RouteParams = { params: Promise<{ slug: string; taskId: string }> };

function quotedExcerpt(excerpt: string): string {
  return excerpt.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(req, {
    slug,
    scopeLabel: "comments:create",
    endpoint: ENDPOINT,
    method: "POST",
    admitLibrarian: true,
    successAuditInWork: true,
    idempotency: {
      kind: "task_publish_excerpt",
      target: { slug, taskId },
      parseBody: async (request) => bodySchema.parse(await request.json()),
    },
    db,
  }, async (ctx) => {
    if (ctx.actor.tokenKind !== "librarian" || !ctx.actor.librarianTurnId || !ctx.operationId) {
      return NextResponse.json({ code: "UNAUTHORIZED", message: "a librarian turn is required" }, { status: 403 });
    }

    let body: z.infer<typeof bodySchema>;

    try {
      body = bodySchema.parse(await req.json());
    } catch (err) {
      return NextResponse.json({ code: "CONFIG", message: `invalid body: ${(err as Error).message}` }, { status: 422 });
    }

    try {
      const response = await db.transaction(async (tx) => {
        const [task] = await tx.select({ id: tasks.id }).from(tasks).where(
          and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)),
        );

        if (!task) return null;

        const [turn] = await tx.select({
          conversationId: librarianTurns.conversationId,
          messageId: librarianTurns.messageId,
        }).from(librarianTurns).where(eq(librarianTurns.id, ctx.actor.librarianTurnId!));

        if (!turn) {
          return NextResponse.json({ code: "PRECONDITION", message: "librarian turn not found" }, { status: 409 });
        }

        const added = await addTaskComment({
          taskId,
          body: quotedExcerpt(body.excerpt),
          actor: socialActorForToken(ctx.actor),
          viaOperationId: ctx.operationId,
          activityPayloadExtra: { via: "librarian", operationId: ctx.operationId },
        }, tx);
        await tx.insert(librarianTaskLinks).values({
          conversationId: turn.conversationId,
          taskId,
          meaning: "mentioned",
          fromMessageId: turn.messageId,
          toMessageId: turn.messageId,
        });
        const [comment] = await toCommentDTOs([added.comment], tx);
        const receipt = { comment };

        await recordRequiredTokenAudit({
          ...tokenAuditIdentity(ctx.actor),
          projectId: ctx.projectId,
          scopeUsed: "comments:create",
          endpoint: ENDPOINT,
          method: "POST",
          result: "ok",
          statusCode: 201,
          operationId: ctx.operationId,
          operation: { id: ctx.operationId!, result: { statusCode: 201, body: receipt } },
        }, tx);

        return receipt;
      });

      if (response === null) {
        return NextResponse.json({ code: "NOT_FOUND", message: "task not found" }, { status: 404 });
      }
      if (response instanceof NextResponse) return response;

      return NextResponse.json(response, { status: 201 });
    } catch (err) {
      if (!isMaisterError(err)) throw err;

      return NextResponse.json({ code: err.code, message: err.message, details: err.details }, {
        status: httpStatusForExtCode(err.code),
      });
    }
  });
}
