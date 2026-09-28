import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireProjectActionForUser } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { getProjectDirectory } from "@/lib/queries/project-directory";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/projects/[slug]/directory";

type RouteParams = { params: Promise<{ slug: string }> };

// A README excerpt is repository content, so it is included only when the
// owner may read repository files (ADR-053) — `readBoard` alone gets the
// routing facts without it.
async function ownerMayReadRepoFiles(
  ownerUserId: string | null,
  projectId: string,
): Promise<boolean> {
  if (ownerUserId === null) return false;

  try {
    await requireProjectActionForUser(ownerUserId, projectId, "readRepoFiles");

    return true;
  } catch (err) {
    if (isMaisterError(err)) return false;
    throw err;
  }
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb();

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "projects:read",
      admitLibrarian: true,
      endpoint: ENDPOINT,
      method: "GET",
      db,
    },
    async (ctx) => {
      const includePurpose =
        ctx.actor.projectId === null
          ? await ownerMayReadRepoFiles(ctx.actor.ownerUserId, ctx.projectId)
          : true;
      const directory = await getProjectDirectory(
        ctx.projectId,
        { includePurpose },
        db,
      );

      if (!directory) {
        return NextResponse.json(
          { code: "NOT_FOUND", message: "project not found" },
          { status: 404 },
        );
      }

      return NextResponse.json(directory, { status: 200 });
    },
  );
}
