import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  authorizeManagePackages,
  errorResponse,
  parseAuthorizedJson,
} from "../../_lib";

import { rollbackFlow } from "@/lib/flows/lifecycle";

const postBodySchema = z.object({ revisionId: z.string().min(1) });

type RouteParams = { params: Promise<{ slug: string; flowRefId: string }> };

// Roll the project's enabled revision back to an older installed revision.
export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowRefId } = await params;

  try {
    const { project, db } = await authorizeManagePackages(slug);
    const body = await parseAuthorizedJson({
      req,
      schema: postBodySchema,
      method: "POST",
    });

    await rollbackFlow({
      projectId: project.id,
      flowRefId,
      revisionId: body.revisionId,
      db,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
