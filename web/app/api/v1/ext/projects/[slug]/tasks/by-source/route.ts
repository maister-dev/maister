import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { getTaskDTO } from "@/lib/services/tasks";
import { findTaskIdBySource } from "@/lib/tasks/external-source/service";
import { taskSourceInputSchema } from "@/lib/tasks/external-source/validate";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/projects/[slug]/tasks/by-source";

// ADR-206: the identity triple only; scope/key/url are never identity.
const querySchema = taskSourceInputSchema
  .pick({ kind: true, instance: true, externalId: true })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

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
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      let identity: z.infer<typeof querySchema>;

      try {
        identity = querySchema.parse(
          Object.fromEntries(req.nextUrl.searchParams.entries()),
        );
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid query: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      const taskId = await findTaskIdBySource(ctx.projectId, identity, db);
      const task = taskId ? await getTaskDTO(taskId, ctx.projectId, db) : null;

      return NextResponse.json({ task }, { status: 200 });
    },
  );
}
