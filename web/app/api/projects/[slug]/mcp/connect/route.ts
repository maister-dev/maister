import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { connectSchema } from "@/lib/mcp/binding-schemas";
import { connectPlatform } from "@/lib/mcp/binding-service";

// ADR-129 (W-D): connect a platform MCP to the project (enabled binding
// target=platform — grandfather pickup made explicit).

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const body = connectSchema.parse(await req.json());
    const binding = await connectPlatform(
      projectId,
      body.platformServerId,
      body.refId,
    );

    return NextResponse.json(binding, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
