import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  createAuthoredCapability,
  listAuthoredCapabilities,
} from "@/lib/catalog/authored-service";
import { createAuthoredCapabilitySchema } from "@/lib/catalog/authored-schema";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await ctx.params;

    await authorizeCatalogRouteProject(slug);
    const caps = await listAuthoredCapabilities({ projectSlug: slug });

    return NextResponse.json({ caps }, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await ctx.params;

    await authorizeCatalogRouteProject(slug);
    const input = createAuthoredCapabilitySchema.parse(await req.json());
    const result = await createAuthoredCapability({
      projectSlug: slug,
      input,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
