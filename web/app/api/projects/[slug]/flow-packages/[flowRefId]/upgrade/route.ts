import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeManagePackages, errorResponse } from "../../_lib";

import { MaisterError } from "@/lib/errors";
import { upgradeFlow } from "@/lib/flows/lifecycle";

const postBodySchema = z.object({
  source: z.string().min(1),
  version: z.string().min(1),
});

type RouteParams = { params: Promise<{ slug: string; flowRefId: string }> };

// Install a new immutable revision beside the current one (two-phase) and mark
// the flow UpdateAvailable. Does NOT auto-enable — the caller enables explicitly.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowRefId } = await params;

  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
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

    const result = await upgradeFlow({
      projectId: project.id,
      flowRefId,
      source: body.source,
      version: body.version,
      db,
    });

    return NextResponse.json(
      { revisionId: result.revisionId },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, slug);
  }
}
