import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { getTaskDTO } from "@/lib/services/tasks";
import { bindTaskSource } from "@/lib/tasks/external-source/service";
import { taskSourceInputSchema } from "@/lib/tasks/external-source/validate";
import { socialActorForToken } from "@/lib/tokens/verify";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

const ENDPOINT = "PUT /api/v1/ext/projects/[slug]/tasks/[taskId]/source";

const bodySchema = taskSourceInputSchema
  .extend({ expectedRevision: z.number().int().nonnegative().optional() })
  .strict();

type RouteParams = { params: Promise<{ slug: string; taskId: string }> };

export async function PUT(
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
      endpoint: ENDPOINT,
      method: "PUT",
      db,
    },
    async (ctx) => {
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

      if (!(await getTaskDTO(taskId, ctx.projectId, db))) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "task not found" },
          { status: 404 },
        );
      }

      const { expectedRevision, ...source } = body;

      try {
        await bindTaskSource(
          {
            projectId: ctx.projectId,
            taskId,
            source,
            actor: socialActorForToken(ctx.actor),
            expectedRevision,
          },
          db,
        );
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message, details: err.details },
            { status: httpStatusForExtCode(err.code) },
          );
        }
        throw err;
      }

      return NextResponse.json(
        { task: await getTaskDTO(taskId, ctx.projectId, db) },
        { status: 200 },
      );
    },
  );
}
