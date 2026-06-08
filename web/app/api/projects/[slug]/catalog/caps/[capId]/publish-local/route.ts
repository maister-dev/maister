import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { publishAuthoredCapabilityLocal } from "@/lib/catalog/authored-service";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { assertPublishableAuthoredFlowRevision } from "@/lib/flows/package-authoring";

type RouteContext = {
  params: Promise<{ slug: string; capId: string }>;
};

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, capId } = await ctx.params;

    await authorizeCatalogRouteProject(slug);
    await assertEmptyBody(req);
    const result = await publishAuthoredCapabilityLocal({
      projectSlug: slug,
      capId,
      validateDraftRevision: (revision) => {
        assertPublishableAuthoredFlowRevision({
          revision,
          context: { projectSlug: slug, slug: capId, action: "publish-local" },
        });
      },
    });

    return NextResponse.json(result.revision, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}

async function assertEmptyBody(req: NextRequest): Promise<void> {
  if (req.body === null) {
    return;
  }

  await req.json();
  throw new SyntaxError("publish-local does not accept a request body");
}
