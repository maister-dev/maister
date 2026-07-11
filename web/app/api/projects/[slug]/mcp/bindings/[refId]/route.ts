import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { patchBindingSchema } from "@/lib/mcp/binding-schemas";
import { deleteBinding, updateBinding } from "@/lib/mcp/binding-service";

// ADR-129 (W-A): rebind / edit overlay / toggle (PATCH) and remove (DELETE) a
// binding. `refId` is the URL locator (server-derived), never a body field.

type RouteContext = { params: Promise<{ slug: string; refId: string }> };

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, refId } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const body = patchBindingSchema.parse(await req.json());
    const binding = await updateBinding(projectId, refId, {
      targetKind: body.targetKind,
      targetId: body.targetId,
      configOverlay: body.configOverlay,
      enabled: body.enabled,
    });

    if (!binding) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `binding not found: ${refId}` },
        { status: 404 },
      );
    }

    return NextResponse.json(binding, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, refId } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const removed = await deleteBinding(projectId, refId);

    if (!removed) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `binding not found: ${refId}` },
        { status: 404 },
      );
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
