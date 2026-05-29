import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeManagePackages, errorResponse } from "../../_lib";

import { MaisterError } from "@/lib/errors";
import { setTrust } from "@/lib/flows/lifecycle";

const postBodySchema = z.object({ trusted: z.boolean() });

type RouteParams = { params: Promise<{ slug: string; flowRefId: string }> };

// Set/clear explicit trust for a flow package in this project.
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
