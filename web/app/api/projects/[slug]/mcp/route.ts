import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { projectMcpBodySchema } from "@/lib/mcp/mcp-form";
import {
  createProjectMcp,
  listProjectMcps,
} from "@/lib/mcp/project-mcp-service";

// M27/T-C5: project-scoped MCP collection. GET lists this project's MCPs
// (capability_records source='project', kind='mcp'); POST creates one. RBAC =
// manageCatalog (project admin), enforced by authorizeCatalogRouteProject — the
// SAME helper the catalog caps routes use. ADR-179: values are whole-value
// `literal | env:NAME`, validated by the ONE shared body schema (it replaced a
// verbatim copy of the pre-ADR-179 key regex that lived here).

const postBodySchema = projectMcpBodySchema;

type RouteContext = {
  params: Promise<{ slug: string }>;
};

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const servers = await listProjectMcps(projectId);

    return NextResponse.json({ servers }, { status: 200 });
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
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const body = postBodySchema.parse(await req.json());
    const dto = await createProjectMcp(projectId, body);

    return NextResponse.json({ ok: true, id: dto.id }, { status: 201 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
