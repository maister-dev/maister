import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { agentsErrorResponse } from "@/lib/agents/admin-shared";
import { detachAgent, updateAgentLink } from "@/lib/agents/project-links";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { decodeRouteParam } from "@/lib/route-params";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

const scheduleSchema = z
  .object({
    triggerType: z.enum(["cron", "event"]),
    cronExpr: z.string().min(1).max(255).optional(),
    timezone: z.string().min(1).max(64).optional(),
    eventKinds: z.array(z.string().min(1)).max(16).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// (ADR-106) Instance runner-policy override — the AgentRunnerPolicy projection
// ({autoApply, onBudgetBreach}); explicit null at the wrapping field clears it.
const executionPolicyOverrideSchema = z
  .object({
    autoApply: z.enum(["off", "permissions", "full"]).optional(),
    onBudgetBreach: z
      .enum(["escalate", "terminate", "terminate_restorable"])
      .optional(),
  })
  .strict();

const patchBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    runnerOverrideId: z.string().min(1).max(128).nullable().optional(),
    // (ADR-106) Per-instance overrides; explicit null clears → fall back to the
    // agent `recommended`.
    branchBase: z.string().min(1).max(255).nullable().optional(),
    executionPolicyOverride: executionPolicyOverrideSchema
      .nullable()
      .optional(),
    schedules: z.array(scheduleSchema).max(16).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field is required",
  });

type RouteParams = { params: Promise<{ slug: string; agentId: string }> };

async function resolveProject(slug: string): Promise<Record<string, any>> {
  const db = getDb() as unknown as { select: any };
  const rows = await db.select().from(projects).where(eq(projects.slug, slug));
  const project = rows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return project;
}

// A missing attachment is a 404 on this surface (spec contract) — the
// generic mapper would turn the service's PRECONDITION into 409.
function notAttachedTo404(err: unknown): NextResponse | null {
  if (isMaisterError(err) && err.message.includes("is not attached")) {
    return NextResponse.json(
      { code: "PRECONDITION", message: err.message },
      { status: 404 },
    );
  }

  return null;
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    await requireActiveSession();
    const agentId = decodeRouteParam(rawAgentId, "agentId");

    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "editSettings");

    const parsed = patchBodySchema.safeParse(await req.json());

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    await updateAgentLink({
      projectId: project.id,
      agentId,
      patch: parsed.data,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return agentsErrorResponse(
        new MaisterError("CONFIG", `invalid JSON body: ${err.message}`),
      );
    }

    return notAttachedTo404(err) ?? agentsErrorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    await requireActiveSession();
    const agentId = decodeRouteParam(rawAgentId, "agentId");

    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "editSettings");

    await detachAgent({ projectId: project.id, agentId });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return notAttachedTo404(err) ?? agentsErrorResponse(err);
  }
}
