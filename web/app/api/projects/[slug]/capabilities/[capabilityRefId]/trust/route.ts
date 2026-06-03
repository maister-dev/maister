import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  authorizeManagePackages,
  errorResponse,
} from "@/app/api/projects/[slug]/flow-packages/_lib";
import { confirmCapabilityTrust } from "@/lib/capabilities/import";
import { MaisterError } from "@/lib/errors";

const postBodySchema = z.object({ confirm: z.literal(true) });

// Identifiers (R-ID): `slug` (url-param) resolves the project row server-side;
// `capabilityRefId` (url-param) is validated against the project's
// capability_imports rows inside confirmCapabilityTrust (server-state). The
// body carries only `{confirm: true}` — no cross-resource locator.
type RouteParams = {
  params: Promise<{ slug: string; capabilityRefId: string }>;
};

// Operator confirms trust for a git-pinned capability import, then its
// trust-gated setup.sh runs (ADR-042). Retry-safe: a re-POST after a setup
// failure re-runs setup; a re-POST after setup is done/not_required is a 409.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, capabilityRefId } = await params;

  try {
    postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
      slug,
    );
  }

  try {
    const { project, db } = await authorizeManagePackages(slug);

    const result = await confirmCapabilityTrust({
      projectId: project.id,
      capabilityRefId,
      db,
    });

    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
