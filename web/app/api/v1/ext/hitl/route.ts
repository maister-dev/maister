import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireActiveUserById } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getCrossProjectHitlInbox } from "@/lib/queries/portfolio";
import { handleExt } from "@/lib/tokens/ext-handler";
import { requirePersonalOrLibrarianActor } from "@/lib/tokens/personal-actor";

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
      admitLibrarian: true,
      auditProjectId: null,
      db,
    },
    async (ctx) => {
      const refused = requirePersonalOrLibrarianActor(ctx.actor, {
        allowLibrarian: true,
      });

      if (refused || ctx.actor.ownerUserId === null) {
        return refused as NextResponse;
      }

      const owner = await requireActiveUserById(ctx.actor.ownerUserId);
      const inbox = await getCrossProjectHitlInbox(owner.id, owner.role);

      // Project to exactly the documented ExtHitlInboxItem shape — the
      // web-internal inbox item carries assignment/actor/agent/schema fields
      // that are NOT part of the external contract and must not cross this
      // boundary (docs/api/external/operations.openapi.yaml).
      const items = inbox.items
        .filter((item) => item.kind !== "decision_request")
        .map((item) => ({
          projectId: item.projectId,
          projectSlug: item.projectSlug,
          runId: item.runId,
          hitlRequestId: item.hitlRequestId,
          kind: item.kind,
          title: item.prompt,
          createdAt: item.createdAt,
          answerState: item.answerState,
        }));

      return NextResponse.json({ items, count: items.length }, { status: 200 });
    },
  );
}
