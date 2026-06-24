import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  agentsErrorResponse,
  projectAgentSummary,
} from "@/lib/agents/admin-shared";
import { attachAgent, getProjectAgentsView } from "@/lib/agents/project-links";
import {
  requireActiveSession,
  requireProjectAction,
  requireProjectRole,
} from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

const postBodySchema = z
  .object({
    // Package-qualified id `<packageName>:<stem>` (ADR-106 re-key).
    agentId: z
      .string()
      .min(1)
      .max(192)
      .regex(/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/),
    enabled: z.boolean().optional(),
    runnerOverrideId: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

async function resolveProject(slug: string): Promise<Record<string, any>> {
  const db = getDb() as unknown as { select: any };
  const rows = await db.select().from(projects).where(eq(projects.slug, slug));
  const project = rows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return project;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();

    const project = await resolveProject(slug);

    await requireProjectRole(project.id, "member");

    const view = await getProjectAgentsView(project.id);

    return NextResponse.json({
      attached: view.attached.map((row) => ({
        ...row,
        agent: projectAgentSummary(row.agent),
      })),
      available: view.available.map(projectAgentSummary),
    });
  } catch (err) {
    return agentsErrorResponse(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();

    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "editSettings");

    const parsed = postBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const { linkId } = await attachAgent({
      projectId: project.id,
      agentId: parsed.data.agentId,
      enabled: parsed.data.enabled,
      runnerOverrideId: parsed.data.runnerOverrideId ?? null,
    });

    return NextResponse.json({ ok: true, linkId }, { status: 201 });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return agentsErrorResponse(
        new MaisterError("CONFIG", `invalid JSON body: ${err.message}`),
      );
    }

    return agentsErrorResponse(err);
  }
}
