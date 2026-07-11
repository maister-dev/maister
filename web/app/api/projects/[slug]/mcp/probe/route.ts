import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { probeSchema } from "@/lib/mcp/binding-schemas";
import { probeAndCache } from "@/lib/mcp/probe-service";

// ADR-129 (W-F): test-connection probe. Resolves the target's NAMES-only config,
// enforces the WEB-SIDE trust gate (untrusted-source stdio → CONFIG, no override
// in v1), proxies to the supervisor, and caches the result. No secret VALUE is
// ever returned to the client or persisted.

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const body = probeSchema.parse(await req.json());
    const result = await probeAndCache(projectId, body);

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
