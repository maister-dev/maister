import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeManagePackages, errorResponse } from "../../_lib";

import { disableFlow } from "@/lib/flows/lifecycle";

type RouteParams = { params: Promise<{ slug: string; flowRefId: string }> };

// Disable a flow for new launches. In-flight runs keep their pinned revision.
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowRefId } = await params;

  try {
    const { project, db } = await authorizeManagePackages(slug);

    await disableFlow({ projectId: project.id, flowRefId, db });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
