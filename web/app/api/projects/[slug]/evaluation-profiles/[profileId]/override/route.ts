import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { putOverrideBodySchema } from "@/lib/evaluations/config-schemas";
import {
  clearProjectOverride,
  getProfile,
  getProjectOverride,
  putProjectOverride,
} from "@/lib/evaluations/config";
import { assertOverridesAllowed } from "@/lib/evaluations/resolution";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";
import { resolveProject } from "@/lib/api/project-route-helpers";

const log = pino({
  name: "api-project-eval-override",
  level: process.env.LOG_LEVEL ?? "info",
});

function overrideDto(row: Record<string, unknown> | null): unknown {
  if (!row) return null;

  return {
    profileId: row.profileId as string,
    revision: row.revision as number,
    overrides: row.overrides,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
  };
}

// GET the saved project override for a Profile (manageProjectEvaluationOverrides,
// project admin). Null when the project inherits the Profile default.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; profileId: string }> },
): Promise<NextResponse> {
  try {
    // Auth-first (repo convention, see tasks route): establish the session
    // BEFORE resolving the slug so unauthenticated callers cannot probe
    // project existence. Project membership is enforced below.
    await requireActiveSession();

    const { slug, profileId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageProjectEvaluationOverrides");

    const override = await getProjectOverride({
      projectId: project.id,
      profileId,
    });

    return NextResponse.json({ override: overrideDto(override) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

// PUT (upsert) the project override; every field must be in the Profile's
// allow-list and within its hard limits (validated at write, D8).
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; profileId: string }> },
): Promise<NextResponse> {
  try {
    await requireActiveSession();

    const { slug, profileId } = await params;
    const project = await resolveProject(slug);
    const access = await requireProjectAction(
      project.id,
      "manageProjectEvaluationOverrides",
    );
    const parsed = putOverrideBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PUT body: ${parsed.error.message}`,
      );
    }

    const profile = await getProfile(profileId);

    assertOverridesAllowed(
      "project",
      parsed.data.overrides,
      profile.allowedOverrides,
      profile.hardLimits,
    );

    const row = await putProjectOverride({
      projectId: project.id,
      profileId,
      overrides: parsed.data.overrides,
      updatedByUserId: access.user.id,
    });

    return NextResponse.json({ override: overrideDto(row) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

// DELETE (clear) the project override — absent means inherit (idempotent).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; profileId: string }> },
): Promise<NextResponse> {
  try {
    await requireActiveSession();

    const { slug, profileId } = await params;
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageProjectEvaluationOverrides");

    const result = await clearProjectOverride({
      projectId: project.id,
      profileId,
    });

    return NextResponse.json(result);
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
