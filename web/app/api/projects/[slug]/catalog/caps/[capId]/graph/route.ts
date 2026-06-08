import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getAuthoredCapability } from "@/lib/catalog/authored-service";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { isMaisterError } from "@/lib/errors";
import { buildAuthoredFlowGraph } from "@/lib/queries/authored-flow-graph";

const log = pino({
  name: "authored-flow-graph-route",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteContext = {
  params: Promise<{ slug: string; capId: string }>;
};

/**
 * M27/T-A1: GET the editable flow-graph for an authored `flow` capability.
 *
 * Identifiers: `slug` + `capId` are url-params resolved to server state.
 * RBAC: `manageCatalog` (project admin) via `authorizeCatalogRouteProject`.
 * The cap must exist within the project (`getAuthoredCapability` is
 * project-scoped → 404 when absent or owned by another project) and be a
 * `flow` (→ 404 otherwise — this endpoint is flow-only).
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
      // The project was already authorized above, so a not-found `CONFIG` from
      // getAuthoredCapability (`loadCapability` throws CONFIG, scoped to the
      // project) is a missing / cross-project capability — surface it as 404.
      // The invalid-manifest CONFIG from `compileManifest` is raised OUTSIDE
      // this inner try, so it still maps to 422 via `catalogErrorResponse`.
      if (isMaisterError(err) && err.code === "CONFIG") {
        log.debug({ slug, capId }, "authored flow graph: capability not found");

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

    const manifest = (detail.draft?.manifest ??
      detail.published?.manifest ??
      null) as FlowYamlV1 | null;

    if (!manifest) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `flow ${capId} has no manifest` },
        { status: 404 },
      );
    }

    const graph = buildAuthoredFlowGraph(
      manifest,
      detail.capability.draftVersion,
    );

    log.debug(
      {
        slug,
        capId,
        draftVersion: graph.draftVersion,
        nodeCount: graph.topology.nodes.length,
        edgeCount: graph.topology.edges.length,
      },
      "authored flow graph built",
    );

    return NextResponse.json(graph, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
