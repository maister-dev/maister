import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { completeTaskInTransaction } from "@/lib/services/task-completion";
import { tokenAuditIdentity } from "@/lib/tokens/audit";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";
import { requirePersonalOrLibrarianActor } from "@/lib/tokens/personal-actor";

const ENDPOINT = "POST /api/v1/ext/projects/[slug]/tasks/[taskId]/complete";

const bodySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };
type Db = any;

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "tasks:complete",
      endpoint: ENDPOINT,
      method: "POST",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      const refused = requirePersonalOrLibrarianActor(ctx.actor, {
        allowLibrarian: false,
      });

      if (refused) return refused;

      let body: z.infer<typeof bodySchema>;

      try {
        body = bodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      try {
        const result = await db.transaction(async (tx: Db) => {
          const completed = await completeTaskInTransaction(
            taskId,
            ctx.projectId,
            {
              expectedRevision: body.expectedRevision,
              actor: { type: "user", id: ctx.actor.ownerUserId as string },
            },
            tx,
          );

          await recordRequiredTokenAudit(
            {
              ...tokenAuditIdentity(ctx.actor),
              projectId: ctx.projectId,
              scopeUsed: "tasks:complete",
              endpoint: ENDPOINT,
              method: "POST",
              result: "ok",
              statusCode: 200,
            },
            tx,
          );

          return completed;
        });

        return NextResponse.json(result, { status: 200 });
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message, details: err.details },
            { status: httpStatusForExtCode(err.code) },
          );
        }

        throw err;
      }
    },
  );
}
