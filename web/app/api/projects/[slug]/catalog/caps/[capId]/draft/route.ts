import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { updateAuthoredDraft } from "@/lib/catalog/authored-service";
import { updateAuthoredDraftSchema } from "@/lib/catalog/authored-schema";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";

type RouteContext = {
  params: Promise<{ slug: string; capId: string }>;
};

// (ADR-149) `sessionId` is optional so headless callers keep working; present,
// it must hold the live edit-lock. It is editor context, not draft content, so
// it is split off before the input reaches the service.
const draftBodySchema = updateAuthoredDraftSchema.extend({
  sessionId: z.string().min(1).max(200).optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, capId } = await ctx.params;

    const { userId } = await authorizeCatalogRouteProject(slug);
    const { sessionId, ...input } = draftBodySchema.parse(await req.json());
    const result = await updateAuthoredDraft({
      projectSlug: slug,
      capId,
      input,
      editor: { sessionId, userId },
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
