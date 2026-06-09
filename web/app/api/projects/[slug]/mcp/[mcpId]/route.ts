import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import {
  deleteProjectMcp,
  getProjectMcp,
  updateProjectMcp,
} from "@/lib/mcp/project-mcp-service";

// M27/T-C5: a single project-scoped MCP. `mcpId` is the capability_records row
// id; EVERY lookup is scoped to the project resolved from `slug`, so a row that
// belongs to another project is invisible and yields 404 — the cross-project
// isolation boundary. RBAC = manageCatalog (project admin), same helper as the
// catalog caps routes. Secrets are env:NAME refs only.

const envKeyRefSchema = z
  .string()
  .regex(
    /^(env:)?[A-Za-z_][A-Za-z0-9_]*$/,
    "secret must be env:NAME, not a value",
  );

const patchBodySchema = z
  .object({
    transport: z.enum(["stdio", "sse", "http"]).optional(),
    command: z.string().min(1).nullable().optional(),
    args: z.array(z.string()).optional(),
    envKeys: z.array(envKeyRefSchema).optional(),
    url: z.string().url().nullable().optional(),
    headerKeys: z.array(envKeyRefSchema).optional(),
    supportedAgents: z
      .array(z.enum(["claude", "codex"]))
      .min(1)
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "no fields to update",
  });

type RouteContext = {
  params: Promise<{ slug: string; mcpId: string }>;
};

// A foreign / unknown mcpId is reported as 404 directly (not via the
// PRECONDITION→409 mapping) — the row simply does not exist for this project.
function notFound(mcpId: string): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: `project MCP not found: ${mcpId}` },
    { status: 404 },
  );
}

export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, mcpId } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const dto = await getProjectMcp(projectId, mcpId);

    if (!dto) return notFound(mcpId);

    return NextResponse.json(dto, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, mcpId } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const patch = patchBodySchema.parse(await req.json());
    const dto = await updateProjectMcp(projectId, mcpId, patch);

    if (!dto) return notFound(mcpId);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug, mcpId } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const removed = await deleteProjectMcp(projectId, mcpId);

    if (!removed) return notFound(mcpId);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
