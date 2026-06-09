import "server-only";

import type { SQL } from "drizzle-orm";

import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { authorizeCatalogRouteProject } from "@/lib/catalog/route-auth";
import { catalogErrorResponse } from "@/lib/catalog/route-errors";
import { getDb } from "@/lib/db/client";
import { resolveRequiredMcps } from "@/lib/mcp/setup-resolve";

// M27/T-C7 (setup-resolve, ADR-069): "Present-by-id → reuse/dedupe (no silent
// duplicate). Absent REQUIRED → propose-to-configure." Classification ONLY —
// this route never creates records and stores no secrets. The operator
// configures an absent mcp via the C5 POST /api/projects/[slug]/mcp create
// route, then re-resolves. Project is derived from the url slug (server state),
// never the body. RBAC = manageCatalog (project admin), same helper as C5.

const postBodySchema = z
  .object({
    requiredIds: z.array(z.string().min(1)),
  })
  .strict();

type RouteContext = {
  params: Promise<{ slug: string }>;
};

type McpRecordRow = { id: string; capability_ref_id: string; source: string };

const log = pino({
  name: "mcp-setup-resolve",
  level: process.env.LOG_LEVEL ?? "info",
});

type ResolveDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

async function loadProjectMcpRecords(
  projectId: string,
): Promise<McpRecordRow[]> {
  const db = getDb() as unknown as ResolveDb;
  const result = await db.execute(sql`
    SELECT id, capability_ref_id, source
    FROM capability_records
    WHERE project_id = ${projectId}
      AND kind = 'mcp'
      AND disabled_at IS NULL
  `);

  return (result.rows ?? []) as McpRecordRow[];
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const { slug } = await ctx.params;
    const { projectId } = await authorizeCatalogRouteProject(slug);
    const { requiredIds } = postBodySchema.parse(await req.json());

    const rows = await loadProjectMcpRecords(projectId);
    const resolutions = resolveRequiredMcps(
      requiredIds,
      rows.map((r) => ({
        id: r.id,
        capabilityRefId: r.capability_ref_id,
        source: r.source,
      })),
    );

    const present = resolutions.filter((r) => r.status === "present");
    const absent = resolutions.filter((r) => r.status === "absent");

    log.debug(
      {
        projectId,
        slug,
        requiredCount: requiredIds.length,
        recordCount: rows.length,
        presentCount: present.length,
        absentCount: absent.length,
        winners: present.map(
          (r) => `${r.refId}@${(r as { scope: string }).scope}`,
        ),
        absent: absent.map((r) => r.refId),
      },
      "[mcp.setup-resolve] classified required mcps",
    );

    return NextResponse.json({ resolutions }, { status: 200 });
  } catch (err) {
    return catalogErrorResponse(err);
  }
}
