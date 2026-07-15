import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { errorResponse, resolveProject } from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { listProjectAutomations } from "@/lib/scheduled-launches/queries";

const log = pino({
  name: "api-project-automations",
  level: process.env.LOG_LEVEL ?? "info",
});

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(512).optional(),
});

type RouteParams = { params: Promise<{ slug: string }> };

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readBoard");
    const parsedQuery = querySchema.safeParse({
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
      cursor: req.nextUrl.searchParams.get("cursor") ?? undefined,
    });
    if (!parsedQuery.success) {
      throw new MaisterError("CONFIG", "automation page query is invalid");
    }
    const query = parsedQuery.data;
    const page = await listProjectAutomations({
      projectId: project.id,
      projectSlug: slug,
      limit: query.limit,
      cursor: query.cursor,
    });

    return NextResponse.json(page);
  } catch (error) {
    return errorResponse(error, log, slug);
  }
}
