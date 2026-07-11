import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  authorizeManagePackages,
  errorResponse,
  parseAuthorizedJson,
} from "../../_lib";

import { setTrust } from "@/lib/flows/lifecycle";

const postBodySchema = z.object({ trusted: z.boolean() });

type RouteParams = { params: Promise<{ slug: string; flowRefId: string }> };

// Set/clear explicit trust for a flow package in this project.
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

    await setTrust({
      projectId: project.id,
      flowRefId,
      trusted: body.trusted,
      db,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
