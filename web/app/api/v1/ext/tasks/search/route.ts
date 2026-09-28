import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { searchVisibleTasks } from "@/lib/queries/task-search";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";
import { personalOwner } from "@/lib/tokens/personal-actor";

const ENDPOINT = "GET /api/v1/ext/tasks/search";

// ADR-186 LAU-06: a search across the owner's visible projects only. The page
// is bounded and says when it is not the whole answer.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: "tasks:read",
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

      try {
        const result = await searchVisibleTasks(
          owner.user,
          {
            q: req.nextUrl.searchParams.get("q") ?? "",
            cursor: req.nextUrl.searchParams.get("cursor"),
          },
          db,
        );

        return NextResponse.json(
          {
            tasks: result.tasks.map((hit) => ({
              taskId: hit.taskId,
              key: hit.key,
              number: hit.number,
              title: hit.title,
              status: hit.status,
              projectId: hit.projectId,
              projectSlug: hit.projectSlug,
              projectName: hit.projectName,
              updatedAt: hit.updatedAt.toISOString(),
              matchedIn: hit.matchedIn,
            })),
            truncated: result.truncated,
            nextCursor: result.nextCursor,
          },
          { status: 200 },
        );
      } catch (err) {
        if (isMaisterError(err)) {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: httpStatusForExtCode(err.code) },
          );
        }
        throw err;
      }
    },
  );
}
