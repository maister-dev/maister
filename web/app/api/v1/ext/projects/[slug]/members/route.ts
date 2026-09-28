import "server-only";

import { and, eq, inArray, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { projectMembers, users } from "@/lib/db/schema";
import { handleExt } from "@/lib/tokens/ext-handler";

type RouteParams = { params: Promise<{ slug: string }> };

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
      endpoint: "GET /api/v1/ext/projects/[slug]/members",
      method: "GET",
      admitLibrarian: true,
      db,
    },
    async (ctx) => {
      const rows = await db
        .select({
          userId: users.id,
          name: users.name,
          role: projectMembers.role,
          globalRole: users.role,
        })
        .from(users)
        .leftJoin(
          projectMembers,
          and(
            eq(projectMembers.userId, users.id),
            eq(projectMembers.projectId, ctx.projectId),
          ),
        )
        .where(
          and(
            eq(users.accountStatus, "active"),
            or(
              eq(users.role, "admin"),
              inArray(projectMembers.role, ["member", "admin", "owner"]),
            ),
          ),
        )
        .orderBy(users.name, users.id);

      return NextResponse.json({
        items: rows.map((row) => ({
          userId: row.userId,
          name: row.name,
          role: row.globalRole === "admin" ? "owner" : row.role,
        })),
      });
    },
  );
}
