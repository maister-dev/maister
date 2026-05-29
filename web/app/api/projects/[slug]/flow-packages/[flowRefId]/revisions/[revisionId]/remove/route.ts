import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeManagePackages, errorResponse } from "../../../../_lib";

import { removeRevision } from "@/lib/flows/lifecycle";

type RouteParams = {
  params: Promise<{ slug: string; flowRefId: string; revisionId: string }>;
};

// Remove an installed revision. Refused (CONFLICT) while any run references it
// or it is a project's enabled revision. revisionId is validated against the
// flow by removeRevision (loadRevisionForFlow rejects cross-flow ids).
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowRefId, revisionId } = await params;

  try {
    const { db } = await authorizeManagePackages(slug);

    await removeRevision({ flowRefId, revisionId, db });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
