import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { disconnectSchema } from "@/lib/mcp/binding-schemas";
import { disconnectRef } from "@/lib/mcp/binding-service";

// ADR-129 (W-D): disconnect (opt-out) a ref in the project — writes a disabled
// binding so the ref is unresolvable even if a platform row matches.

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const body = disconnectSchema.parse(await req.json());
    const binding = await disconnectRef(projectId, body.refId);

    return NextResponse.json(binding, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
