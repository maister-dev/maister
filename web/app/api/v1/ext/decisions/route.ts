import "server-only";

import type { DecisionItem } from "@/lib/queries/decisions";

import { NextRequest, NextResponse } from "next/server";

import { requireActiveUserById } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getDecisionsQueue } from "@/lib/queries/decisions";
import { handleExt } from "@/lib/tokens/ext-handler";

const ENDPOINT = "GET /api/v1/ext/decisions";
const SCOPE = "decisions:read";

// The ONE action that clears the entry. A crashed run whose session cannot be
// resumed can still always be discarded, which is why `null` maps to `discard`
// rather than to an absent action the contract has no room for.
function nextActionOf(
  item: DecisionItem,
): "respond" | "promote" | "recover" | "discard" | "review" {
  if (item.kind === "hitl") return "respond";
  if (item.kind === "promotable") return "promote";
  if (item.kind === "flagged") return "review";

  return item.crashed.action === "recover" ? "recover" : "discard";
}

function extTitle(item: DecisionItem): string {
  if (item.kind === "hitl") return item.hitl.prompt;

  return item.taskTitle ?? item.taskKey ?? item.projectSlug;
}

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
      // A decision queue is a PERSON's queue. A project token has no person, and
      // an agent token must never read one — so this is the narrowest of the ext
      // actors: a global personal token and nothing else.
      if (
        ctx.actor.tokenKind !== "user" ||
        ctx.actor.ownerUserId === null ||
        ctx.actor.projectId !== null
      ) {
        return NextResponse.json(
          { code: "UNAUTHORIZED", message: "global personal token required" },
          { status: 403 },
        );
      }

      const owner = await requireActiveUserById(ctx.actor.ownerUserId);
      const queue = await getDecisionsQueue(owner.id, owner.role);

      // Project to exactly the documented ExtDecisionItem shape. The internal
      // item carries the whole source payload (`hitl`, `crashed`, …) — none of
      // it is part of the external contract, and a spread would leak all of it,
      // including the HITL row's raw schema and the crashed run's session
      // handle. Field by field, never a spread.
      // ATN-08: a `decision_request` HITL never crosses this boundary.
      const items = queue.items
        .filter(
          (item) =>
            item.kind !== "hitl" || item.hitl.kind !== "decision_request",
        )
        .map((item) => ({
          kind: item.kind,
          projectId: item.projectId,
          projectSlug: item.projectSlug,
          taskKey: item.taskKey,
          runId: item.runId,
          hitlRequestId: item.kind === "hitl" ? item.hitl.hitlRequestId : null,
          title: extTitle(item),
          criticality: item.criticality,
          nextAction: nextActionOf(item),
          createdAt: item.since === null ? null : item.since.toISOString(),
        }));

      return NextResponse.json({ items, count: items.length }, { status: 200 });
    },
  );
}
