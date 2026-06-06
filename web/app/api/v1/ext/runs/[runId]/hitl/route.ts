import "server-only";

import type { HitlRequest } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { extractOptions, getHitlRequestsForRun } from "@/lib/queries/hitl";
import { handleExt } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "GET /api/v1/ext/runs/[runId]/hitl";
const SCOPE = "hitl:read";

type ExtHitlRequestDTO = {
  hitlRequestId: string;
  stepId: string;
  kind: HitlRequest["kind"];
  prompt: string;
  schema: unknown;
  options: { optionId: string; label: string }[];
  criticality: "low" | "medium" | "high" | "critical" | null;
  requestedAt: string;
};

function toExtHitlDTO(row: HitlRequest): ExtHitlRequestDTO {
  return {
    hitlRequestId: row.id,
    stepId: row.stepId,
    kind: row.kind,
    prompt: row.prompt,
    // permission `schema` carries supervisor-internal handles (requestId,
    // supervisorSessionId, toolCall) written by runner-agent — NEVER cross the
    // external trust boundary. The OpenAPI contract documents schema=null for
    // permission; the actionable surface is `options` (projected below).
    schema: row.kind === "permission" ? null : (row.schema ?? null),
    options: extractOptions(row.kind, row.schema),
    criticality: row.criticality ?? null,
    requestedAt: row.createdAt.toISOString(),
  };
}

type RouteParams = { params: Promise<{ runId: string }> };

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint: ENDPOINT,
      method: "GET",
      requireScope: true,
      db,
    },
    async (ctx) => {
      // Existence-hide: a run outside the token's project is indistinguishable
      // from a missing run (both 404).
      const runRows = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.projectId, ctx.projectId)));

      if (runRows.length === 0) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "run not found" },
          { status: 404 },
        );
      }

      const rows = await getHitlRequestsForRun(runId, ctx.projectId, { db });

      return NextResponse.json(
        { hitl: rows.map(toExtHitlDTO) },
        { status: 200 },
      );
    },
  );
}
