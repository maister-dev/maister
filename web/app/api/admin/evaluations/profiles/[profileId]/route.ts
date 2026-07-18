import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import {
  patchProfileBodySchema,
  toEvaluationProfileDto,
} from "@/lib/evaluations/config-schemas";
import {
  deleteProfile,
  getProfile,
  patchProfile,
} from "@/lib/evaluations/config";
import { MaisterError } from "@/lib/errors";
import {
  evalErrorResponse,
  parseEvalJson,
  requireIfMatchRevision,
} from "@/lib/evaluations/route-helpers";

const log = pino({
  name: "api-admin-eval-profile",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { profileId } = await params;
    const profile = await getProfile(profileId);

    return NextResponse.json({ profile: toEvaluationProfileDto(profile) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireGlobalRole("admin");
    const { profileId } = await params;
    const expectedRevision = requireIfMatchRevision(req);
    const parsed = patchProfileBodySchema.safeParse(await parseEvalJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    const profile = await patchProfile({
      profileId,
      expectedRevision,
      name: parsed.data.name,
      defaults: parsed.data.defaults,
      hardLimits: parsed.data.hardLimits,
      allowedOverrides: parsed.data.allowedOverrides,
      enabled: parsed.data.enabled,
      updatedByUserId: user.id,
    });

    return NextResponse.json({ profile: toEvaluationProfileDto(profile) });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ profileId: string }> },
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { profileId } = await params;
    const expectedRevision = requireIfMatchRevision(req);

    // The If-Match revision is enforced atomically inside the delete's WHERE
    // (stale → 409, missing → 404) — no read-then-delete race window.
    await deleteProfile({ profileId, expectedRevision });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return evalErrorResponse(err, log);
  }
}
