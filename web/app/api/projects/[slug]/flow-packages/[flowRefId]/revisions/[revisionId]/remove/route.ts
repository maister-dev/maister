import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { authorizeManagePackages, errorResponse } from "../../../../_lib";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { removeRevision } from "@/lib/flows/lifecycle";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { flows } = schemaModule as unknown as Record<string, any>;

type RouteParams = {
  params: Promise<{ slug: string; flowRefId: string; revisionId: string }>;
};

// Remove an installed revision. Refused (CONFLICT) while any run references it
// or it is a project's enabled revision. The revisionId is validated against
// the project's flow AND its declared source by removeRevision
// (loadRevisionForFlow rejects cross-flow and cross-source ids).
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowRefId, revisionId } = await params;

  try {
    const { project, db } = await authorizeManagePackages(slug);

    const flowRows = await db
      .select({ source: flows.source })
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

    await removeRevision({
      flowRefId,
      revisionId,
      expectedSource: flow.source,
      db,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
