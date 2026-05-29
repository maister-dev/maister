import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeManagePackages, errorResponse } from "../../_lib";

import { MaisterError } from "@/lib/errors";
import { rollbackFlow } from "@/lib/flows/lifecycle";

const postBodySchema = z.object({ revisionId: z.string().min(1) });

type RouteParams = { params: Promise<{ slug: string; flowRefId: string }> };

// Roll the project's enabled revision back to an older installed revision.
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
