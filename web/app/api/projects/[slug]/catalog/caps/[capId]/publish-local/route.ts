import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { publishAuthoredCapabilityLocal } from "@/lib/catalog/authored-service";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { bridgePublishedAuthoredFlow } from "@/lib/flows/authored-bridge";
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

    // Two-phase: publish tx committed above; bridge runs AFTER the commit.
    // flow kind → bridge into flows + flow_revisions (ADR-061, T-B2).
    let flowBridge: { flowRowId: string; revisionId: string } | undefined;

    if (result.revision.kind === "flow") {
      flowBridge = await bridgePublishedAuthoredFlow({
        projectSlug: slug,
        projectId: result.revision.projectId,
        capId,
        revision: {
          id: result.revision.id,
          revisionNumber: result.revision.revisionNumber,
          contentHash: result.revision.contentHash,
          body: result.revision.body,
          title: result.revision.title,
        },
      });
    }

    return NextResponse.json(
      {
        ...result.revision,
        ...(flowBridge !== undefined
          ? {
              flowRowId: flowBridge.flowRowId,
              revisionId: flowBridge.revisionId,
            }
          : {}),
      },
      { status: 200 },
    );
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
