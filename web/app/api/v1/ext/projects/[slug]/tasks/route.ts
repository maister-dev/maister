import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { createTask } from "@/lib/services/tasks";
import { listTaskDTOs } from "@/lib/services/tasks";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

const ENDPOINT_TASKS = "POST /api/v1/ext/projects/[slug]/tasks";
const ENDPOINT_TASKS_GET = "GET /api/v1/ext/projects/[slug]/tasks";

const postBodySchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    flowId: z.string().min(1),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "tasks:create",
      endpoint: ENDPOINT_TASKS,
      method: "POST",
      db,
    },
    async (ctx) => {
      // Authenticate first (handleExt above), then validate the body.
      let body: z.infer<typeof postBodySchema>;

      try {
        body = postBodySchema.parse(await req.json());
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
        const { taskId } = await createTask(
          {
            title: body.title,
            prompt: body.prompt,
            flowId: body.flowId,
          },
          { projectId: ctx.projectId, actorUserId: null },
          db,
        );

        return NextResponse.json({ taskId }, { status: 201 });
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

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "tasks:read",
      endpoint: ENDPOINT_TASKS_GET,
      method: "GET",
      db,
    },
    async (ctx) => {
      const tasks = await listTaskDTOs(ctx.projectId, db);

      return NextResponse.json({ tasks }, { status: 200 });
    },
  );
}
