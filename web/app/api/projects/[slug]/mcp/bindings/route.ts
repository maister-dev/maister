import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { createBindingSchema } from "@/lib/mcp/binding-schemas";
import { createBinding } from "@/lib/mcp/binding-service";

// ADR-129 (W-A): create a project MCP binding. `project_id` is server-state
// (from the slug); the body carries the ref + target + optional overlay.
// target_kind/target_id are validated against server-state in the service.

type RouteContext = { params: Promise<{ slug: string }> };

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const body = createBindingSchema.parse(await req.json());
    const binding = await createBinding(projectId, {
      refId: body.refId,
      targetKind: body.targetKind,
      targetId: body.targetId,
      configOverlay: body.configOverlay,
    });

    return NextResponse.json(binding, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
