import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { tasks } from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { answerClarification } from "@/lib/tasks/clarification-requests";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { tokenHasExactScope } from "@/lib/tokens/scopes";

const ENDPOINT =
  "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/clarifications/[id]/answer";
const SCOPE = "hitl:respond:human";
const bodySchema = z
  .object({ answer: z.union([z.string(), z.boolean()]) })
  .strict();

type RouteParams = {
  params: Promise<{ slug: string; taskId: string; id: string }>;
};

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId, id } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: SCOPE,
      endpoint: ENDPOINT,
      method: "POST",
      requireScope: true,
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      if (
        ctx.actor.tokenKind !== "user" ||
        ctx.actor.projectId !== null ||
        !ctx.actor.ownerUserId ||
        !tokenHasExactScope(ctx.actor.scopes, SCOPE)
      ) {
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "a personal human response token is required",
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

      try {
        const { answer } = bodySchema.parse(await req.json());
        const receipt = await answerClarification(
          {
            taskId,
            clarificationId: id,
            recipientUserId: ctx.actor.ownerUserId,
            answer,
            recordAnswered: (tx) =>
              recordRequiredTokenAudit(
                {
                  ...tokenAuditIdentity(ctx.actor),
                  projectId: ctx.projectId,
                  scopeUsed: SCOPE,
                  endpoint: ENDPOINT,
                  method: "POST",
                  result: "ok",
                  statusCode: 200,
                },
                tx,
              ),
          },
          db,
        );

        return NextResponse.json(receipt);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return NextResponse.json(
            { code: "CONFIG", message: "invalid clarification answer" },
            { status: 422 },
          );
        }
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
