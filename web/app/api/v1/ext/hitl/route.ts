import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireActiveUserById } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getCrossProjectHitlInbox } from "@/lib/queries/portfolio";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/hitl";
const SCOPE = "hitl:inbox:read";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint: ENDPOINT,
      method: "GET",
      allowGlobalActorWithoutProject: true,
      auditProjectId: null,
      db,
    },
    async (ctx) => {
      if (ctx.actor.tokenKind !== "user" || ctx.actor.ownerUserId === null) {
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "global personal token required",
          },
          { status: 403 },
        );
      }

      if (ctx.actor.projectId !== null) {
        return NextResponse.json(
          {
            code: "UNAUTHORIZED",
            message: "global personal token required",
          },
          { status: 403 },
        );
      }

      const owner = await requireActiveUserById(ctx.actor.ownerUserId);
      const inbox = await getCrossProjectHitlInbox(owner.id, owner.role);

      return NextResponse.json(
        { items: inbox.items, count: inbox.count },
        { status: 200 },
      );
    },
  );
}
