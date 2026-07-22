import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import {
  getCurrentStandardizedRecipe,
  toStandardizedRecipeDto,
} from "@/lib/evaluations/standardization";
import { evalErrorResponse } from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-standardization",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string }> };

// GET — the current standardized recipe for a slot (manageProjectEvaluationOverrides,
// admin). Returns the highest revision for `(project, slot)`, or null.
export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    await requireActiveSession();

    const { slug } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageProjectEvaluationOverrides");

    const slot = req.nextUrl.searchParams.get("slot")?.trim() || "default";
    const current = await getCurrentStandardizedRecipe({
      projectId: project.id,
      slot,
    });

    return NextResponse.json({
      current: current ? toStandardizedRecipeDto(current) : null,
    });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
