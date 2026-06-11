import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import {
  createProjectMcp,
  listProjectMcps,
} from "@/lib/mcp/project-mcp-service";

// M27/T-C5: project-scoped MCP collection. GET lists this project's MCPs
// (capability_records source='project', kind='mcp'); POST creates one. RBAC =
// manageCatalog (project admin), enforced by authorizeCatalogRouteProject — the
// SAME helper the catalog caps routes use. Secrets are env:NAME refs only.

const envKeyRefSchema = z
  .string()
  .regex(
    /^(env:)?[A-Za-z_][A-Za-z0-9_]*$/,
    "secret must be env:NAME, not a value",
  );

const postBodySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/),
    transport: z.enum(["stdio", "sse", "http"]),
    command: z.string().min(1).nullable().optional(),
    args: z.array(z.string()).optional(),
    envKeys: z.array(envKeyRefSchema).optional(),
    url: z.string().url().nullable().optional(),
    headerKeys: z.array(envKeyRefSchema).optional(),
    supportedAgents: z.array(z.enum(ADAPTER_IDS)).min(1).optional(),
  })
  .strict();

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
