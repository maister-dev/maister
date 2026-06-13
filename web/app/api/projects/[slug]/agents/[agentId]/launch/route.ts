import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { agentsErrorResponse } from "@/lib/agents/admin-shared";
import { launchAgentRun } from "@/lib/agents/launch";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { decodeRouteParam } from "@/lib/route-params";

const { projects } = schemaModule as unknown as Record<string, any>;

const bodySchema = z
  .object({
    taskId: z.string().uuid().optional(),
    runnerId: z.string().min(1).max(128).optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string; agentId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    // Authz-first: authenticate before resolving the slug; project
    // membership is enforced right after the minimal project lookup.
    await requireActiveSession();
    const agentId = decodeRouteParam(rawAgentId, "agentId");

    const db = getDb() as unknown as { select: any };
    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "launchRun");

    let body: z.infer<typeof bodySchema> = {};

    const raw = await req.text();

    if (raw.trim() !== "") {
      const parsed = bodySchema.safeParse(JSON.parse(raw));

      if (!parsed.success) {
        throw new MaisterError(
          "CONFIG",
          `invalid POST body: ${parsed.error.message}`,
        );
      }
      body = parsed.data;
    }

    const result = await launchAgentRun({
      agentId,
      projectId: project.id,
      taskId: body.taskId ?? null,
      launchOverrideRunnerId: body.runnerId ?? null,
      trigger: { source: "manual" },
    });

    if ("deduped" in result) {
      throw new MaisterError("CONFLICT", "agent trigger already claimed");
    }

    return NextResponse.json(
      {
        runId: result.runId,
        status: result.status,
        ...(result.queuePosition !== undefined
          ? { queuePosition: result.queuePosition }
          : {}),
      },
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof SyntaxError) {
      return agentsErrorResponse(
        new MaisterError("CONFIG", `invalid JSON body: ${err.message}`),
      );
    }

    return agentsErrorResponse(err);
  }
}
