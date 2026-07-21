import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse } from "@/lib/api/project-route-helpers";
import { isLockableCapability, releaseLock } from "@/lib/catalog/authored-lock";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";

// (ADR-149) Release is session-fenced in the helper, so a stale release from a
// superseded session clears nothing instead of dropping the live lock.
type RouteContext = {
  params: Promise<{ slug: string; capId: string }>;
};

const bodySchema = z.object({ sessionId: z.string().min(1).max(200) }).strict();

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, capId } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const parsed = bodySchema.parse(await req.json());

    if (!(await isLockableCapability(projectId, capId))) {
      return notFoundResponse("authored capability not found");
    }

    await releaseLock(capId, parsed.sessionId);

    return NextResponse.json({ released: true }, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
