import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import {
  createProfileBodySchema,
  toEvaluationProfileDto,
} from "@/lib/evaluations/config-schemas";
import { createProfile, listProfiles } from "@/lib/evaluations/config";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-admin-eval-profiles",
  level: process.env.LOG_LEVEL ?? "info",
});

// GET /api/admin/evaluations/profiles — list profiles (manageEvaluationConfig).
export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const profiles = (await listProfiles()).map(toEvaluationProfileDto);

    return NextResponse.json({ profiles });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

// POST /api/admin/evaluations/profiles — create a profile (one method revision
// + one panel + defaults/hard limits/allowed overrides).
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("admin");
    const parsed = createProfileBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const profile = await createProfile({
      name: parsed.data.name,
      methodRevisionId: parsed.data.methodRevisionId,
      panelId: parsed.data.panelId,
      defaults: parsed.data.defaults ?? null,
      hardLimits: parsed.data.hardLimits ?? null,
      allowedOverrides: parsed.data.allowedOverrides ?? null,
      createdByUserId: user.id,
    });

    return NextResponse.json(
      { profile: toEvaluationProfileDto(profile) },
      { status: 201 },
    );
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
