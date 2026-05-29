import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { authorizeManagePackages, errorResponse } from "../../_lib";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { upgradePreview } from "@/lib/flows/lifecycle";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { flows } = schemaModule as unknown as Record<string, any>;

type RouteParams = { params: Promise<{ slug: string; flowRefId: string }> };

// Structured contract diff of the enabled revision vs a candidate revision.
// candidate revisionId is a query param, validated against the flow downstream.
export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowRefId } = await params;
  const revisionId = req.nextUrl.searchParams.get("revisionId");

  try {
    if (!revisionId) {
      throw new MaisterError("CONFIG", "missing required ?revisionId");
    }

    const { project, db } = await authorizeManagePackages(slug);

    const flowRows = await db
      .select({
        enabledRevisionId: flows.enabledRevisionId,
        source: flows.source,
      })
      .from(flows)
      .where(
        and(eq(flows.projectId, project.id), eq(flows.flowRefId, flowRefId)),
      );
    const flow = flowRows[0];

    if (!flow) {
      throw new MaisterError(
        "PRECONDITION",
        `flow "${flowRefId}" is not configured for project ${slug}`,
      );
    }

    const preview = await upgradePreview({
      flowRefId,
      enabledRevisionId: flow.enabledRevisionId,
      candidateRevisionId: revisionId,
      expectedSource: flow.source,
      db,
    });

    return NextResponse.json(preview, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
