import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { librarianTurns, taskClarifications, tasks } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  clarificationRequestSchema,
  requestClarification,
} from "@/lib/tasks/clarification-requests";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

const ENDPOINT =
  "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/clarifications";

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "tasks:read",
      endpoint: "GET /api/v1/ext/projects/[slug]/tasks/[taskId]/clarifications",
      method: "GET",
      admitLibrarian: true,
      db,
    },
    async (ctx) => {
      const [task] = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)));

      if (!task)
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      const rows = await db
        .select({
          id: taskClarifications.id,
          seq: taskClarifications.seq,
          originKind: taskClarifications.originKind,
          question: taskClarifications.question,
          answer: taskClarifications.answer,
          reason: taskClarifications.reason,
          answerFormat: taskClarifications.answerFormat,
          requesterUserId: taskClarifications.requesterUserId,
          recipientUserId: taskClarifications.recipientUserId,
          blocking: taskClarifications.blocking,
          status: taskClarifications.status,
          cancelReason: taskClarifications.cancelReason,
          answeredAt: taskClarifications.answeredAt,
          createdAt: taskClarifications.createdAt,
        })
        .from(taskClarifications)
        .where(eq(taskClarifications.taskId, taskId))
        .orderBy(taskClarifications.seq);

      return NextResponse.json({ items: rows });
    },
  );
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "hitl:request",
      endpoint: ENDPOINT,
      method: "POST",
      admitLibrarian: true,
      successAuditInWork: true,
      idempotency: {
        kind: "clarification_request",
        target: { slug, taskId },
        parseBody: async (request) =>
          clarificationRequestSchema.parse(await request.json()),
      },
      db,
    },
    async (ctx) => {
      if (
        ctx.actor.tokenKind !== "librarian" ||
        !ctx.actor.ownerUserId ||
        !ctx.actor.librarianTurnId ||
        !ctx.operationId
      ) {
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "an owner-message librarian turn is required",
          },
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
      const [turn] = await db
        .select({
          messageId: librarianTurns.messageId,
          variant: librarianTurns.variant,
        })
        .from(librarianTurns)
        .where(eq(librarianTurns.id, ctx.actor.librarianTurnId));

      if (turn?.variant !== "owner_message" || !turn.messageId) {
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "an owner-message librarian turn is required",
          },
          { status: 403 },
        );
      }

      try {
        const request = clarificationRequestSchema.parse(await req.json());
        const receipt = await requestClarification(
          {
            taskId,
            requesterUserId: ctx.actor.ownerUserId,
            sourceMessageId: turn.messageId,
            viaOperationId: ctx.operationId,
            request,
            recordCreated: async (tx, created) => {
              await recordRequiredTokenAudit(
                {
                  ...tokenAuditIdentity(ctx.actor),
                  projectId: ctx.projectId,
                  scopeUsed: "hitl:request",
                  endpoint: ENDPOINT,
                  method: "POST",
                  result: "ok",
                  statusCode: 201,
                  operationId: ctx.operationId,
                  operation: {
                    id: ctx.operationId!,
                    result: { statusCode: 201, body: created },
                  },
                },
                tx,
              );
            },
          },
          db,
        );

        return NextResponse.json(receipt, { status: 201 });
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
