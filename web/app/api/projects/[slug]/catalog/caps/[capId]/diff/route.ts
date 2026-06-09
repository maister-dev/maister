import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getAuthoredCapability } from "@/lib/catalog/authored-service";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { isMaisterError } from "@/lib/errors";
import { buildAuthoredFlowDiff } from "@/lib/queries/authored-flow-diff";

const log = pino({
  name: "authored-flow-diff-route",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteContext = {
  params: Promise<{ slug: string; capId: string }>;
};

/**
 * M27/T-A6: GET the draft-vs-published diff for an authored `flow` capability.
 *
 * Identifiers: `slug` + `capId` are url-params resolved to server state.
 * RBAC: `manageCatalog` (project admin) via `authorizeCatalogRouteProject`.
 * The cap must exist within the project and be a `flow` (→ 404 otherwise).
 * A flow with no published revision diffs against an empty published side.
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, capId } = await ctx.params;

    await authorizeCatalogRouteProject(slug);

    let detail;

    try {
      detail = await getAuthoredCapability({ projectSlug: slug, capId });
    } catch (err) {
      if (isMaisterError(err) && err.code === "CONFIG") {
        log.debug({ slug, capId }, "authored flow diff: capability not found");

        return NextResponse.json(
          { code: err.code, message: err.message },
          { status: 404 },
        );
      }
      throw err;
    }

    if (detail.capability.kind !== "flow") {
      return NextResponse.json(
        { code: "PRECONDITION", message: `capability ${capId} is not a flow` },
        { status: 404 },
      );
    }

    const draftManifest = (detail.draft?.manifest ??
      detail.published?.manifest ??
      null) as FlowYamlV1 | null;

    if (!draftManifest) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `flow ${capId} has no manifest` },
        { status: 404 },
      );
    }

    const publishedManifest = (detail.published?.manifest ??
      null) as FlowYamlV1 | null;

    const result = buildAuthoredFlowDiff(
      draftManifest,
      publishedManifest,
      detail.capability.draftVersion,
    );

    log.debug(
      {
        slug,
        capId,
        draftVersion: result.draftVersion,
        changed: result.diff.length > 0,
        hasPublished: publishedManifest !== null,
      },
      "authored flow diff built",
    );

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
