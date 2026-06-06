import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getAuthoredCapability } from "@/lib/catalog/authored-service";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";

type RouteContext = {
  params: Promise<{ slug: string; capId: string }>;
};

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, capId } = await ctx.params;

    await authorizeCatalogRouteProject(slug);
    const detail = await getAuthoredCapability({ projectSlug: slug, capId });

    return NextResponse.json(detail, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
