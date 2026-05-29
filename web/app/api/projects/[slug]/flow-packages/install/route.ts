import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeManagePackages, errorResponse } from "../_lib";

import { MaisterError } from "@/lib/errors";
import { installFlowPlugin } from "@/lib/flows";

const postBodySchema = z.object({
  flowRefId: z.string().min(1),
  source: z.string().min(1),
  version: z.string().min(1),
});

type RouteParams = { params: Promise<{ slug: string }> };

// Install a new Flow package into the project (install + enablement pointer).
// Two-phase install lives in installFlowPlugin -> installRevision (Installing ->
// Installed/Failed). Identifiers: slug = url-param (server-state); flowRefId/
// source/version = body-controlled, validated downstream by flowIdSchema /
// the loader boundary. No filesystem path is built from a raw body field.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

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

    const result = await installFlowPlugin({
      source: body.source,
      version: body.version,
      projectId: project.id,
      projectSlug: project.slug,
      flowId: body.flowRefId,
      db,
    });

    return NextResponse.json(
      {
        flowRowId: result.flowRowId,
        revisionId: result.revisionId,
        revision: result.revision,
        trustStatus: result.trustStatus,
        enablementState: result.enablementState,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, slug);
  }
}
