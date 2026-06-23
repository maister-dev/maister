import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { getTaskDTO, updateTask } from "@/lib/services/tasks";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

const ENDPOINT_TASK_GET = "GET /api/v1/ext/projects/[slug]/tasks/[taskId]";
const ENDPOINT_TASK_PATCH = "PATCH /api/v1/ext/projects/[slug]/tasks/[taskId]";

const patchBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };
type TransactionalDb = {
  transaction<T>(scope: (tx: unknown) => Promise<T>): Promise<T>;
};

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
      endpoint: ENDPOINT_TASK_GET,
      method: "GET",
      db,
    },
    async (ctx) => {
      const task = await getTaskDTO(taskId, ctx.projectId, db);

      if (!task) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      return NextResponse.json(task, { status: 200 });
    },
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, taskId } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "tasks:update",
      endpoint: ENDPOINT_TASK_PATCH,
      method: "PATCH",
      successAuditInWork: true,
      db,
    },
    async (ctx) => {
      // Authenticate first (handleExt above), then validate the body.
      let body: z.infer<typeof patchBodySchema>;

      try {
        body = patchBodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      const task = await getTaskDTO(taskId, ctx.projectId, db);

      if (!task) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      try {
        const updated = await (db as TransactionalDb).transaction(
          async (tx) => {
            const task = await updateTask(taskId, ctx.projectId, body, tx);

            await recordRequiredTokenAudit(
              {
                tokenId: ctx.actor.tokenId,
                projectId: ctx.projectId,
                actorLabel: ctx.actor.actorLabel,
                scopeUsed: "tasks:update",
                endpoint: ENDPOINT_TASK_PATCH,
                method: "PATCH",
                result: "ok",
                statusCode: 200,
              },
              tx,
            );

            return task;
          },
        );

        return NextResponse.json(updated, { status: 200 });
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: httpStatusForExtCode(err.code) },
          );
        }
        throw err;
      }
    },
  );
}
