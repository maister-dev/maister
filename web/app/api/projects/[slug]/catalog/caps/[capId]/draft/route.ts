import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { updateAuthoredDraft } from "@/lib/catalog/authored-service";
import { updateAuthoredDraftSchema } from "@/lib/catalog/authored-schema";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";

type RouteContext = {
  params: Promise<{ slug: string; capId: string }>;
};

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, capId } = await ctx.params;

    await authorizeCatalogRouteProject(slug);
    const input = updateAuthoredDraftSchema.parse(await req.json());
    const result = await updateAuthoredDraft({
      projectSlug: slug,
      capId,
      input,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
