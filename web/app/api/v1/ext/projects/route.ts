import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { getVisibleProjects } from "@/lib/queries/visible-projects";
import { handleExt } from "@/lib/tokens/ext-handler";
import { personalOwner } from "@/lib/tokens/personal-actor";

const ENDPOINT = "GET /api/v1/ext/projects";
const log = pino({
  name: "ext-projects-route",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-186: the projects the token's owner can see — the librarian's entry
// point for discovery. Nothing outside the owner's visibility is listed.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "projects:read",
      endpoint: ENDPOINT,
      method: "GET",
      allowGlobalActorWithoutProject: true,
      admitLibrarian: true,
      auditProjectId: null,
      db,
    },
    async (ctx) => {
      const owner = await personalOwner(ctx.actor);

      if (!owner.ok) return owner.response;

      const projects = await getVisibleProjects(
        owner.user.id,
        owner.user.role,
        db,
      );

      log.debug(
        { route: ENDPOINT, visibleProjects: projects.length },
        "served visible projects",
      );

      return NextResponse.json(
        {
          projects: projects.map((project) => ({
            id: project.id,
            slug: project.slug,
            name: project.name,
          })),
        },
        { status: 200 },
      );
    },
  );
}
