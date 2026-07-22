import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { resolveProject } from "@/lib/api/project-route-helpers";
import {
  rollbackStandardization,
  toStandardizedRecipeDto,
} from "@/lib/evaluations/standardization";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseOptionalEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-project-eval-standardization-rollback",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z
  .object({ slot: z.string().min(1).max(64).optional() })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

// POST — roll a slot back to its previous standardized recipe
// (manageProjectEvaluationOverrides, admin). Appends a `rollback` ledger row;
// history is never rewritten. A slot with fewer than two revisions is a 409.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const session = await requireActiveSession();

    const { slug } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageProjectEvaluationOverrides");

    const parsed = bodySchema.safeParse(await parseOptionalEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const row = await rollbackStandardization({
      projectId: project.id,
      slot: parsed.data.slot,
      actor: { type: "user", id: session.id },
    });

    return NextResponse.json(toStandardizedRecipeDto(row), { status: 201 });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
