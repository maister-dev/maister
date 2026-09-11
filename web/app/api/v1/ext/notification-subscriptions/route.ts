import "server-only";

/**
 * `GET|POST /api/v1/ext/notification-subscriptions` (ADR-172 D9, `NTF-07`).
 *
 * Scope `notifications:subscriptions`. The owner comes from `auth-context` and
 * nowhere else: there is no parameter naming a user, and a body that names one
 * is REFUSED rather than ignored — silently dropping it would let a caller
 * believe they had set an owner.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  listNotificationSubscriptions,
  upsertNotificationSubscription,
  validateSubscriptionInput,
} from "@/lib/notifications/subscriptions";
import { getDb } from "@/lib/db/client";
import { handleExt } from "@/lib/tokens/ext-handler";
import { isMaisterError } from "@/lib/errors";
import { requireActiveUserById } from "@/lib/authz";

const SCOPE = "notifications:subscriptions";

/**
 * A notification subscription is a PERSON's. A project token has no person and
 * an agent token must never hold this scope (D10), so this is the narrowest of
 * the ext actors — a global personal token and nothing else, matching
 * `GET /api/v1/ext/decisions`.
 */
function refuseNonPersonal(ctx: {
  actor: {
    tokenKind: string;
    ownerUserId: string | null;
    projectId: string | null;
  };
}): NextResponse | null {
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

  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint: "GET /api/v1/ext/notification-subscriptions",
      method: "GET",
      allowGlobalActorWithoutProject: true,
      auditProjectId: null,
      db,
    },
    async (ctx) => {
      const refused = refuseNonPersonal(ctx);

      if (refused) return refused;

      const owner = await requireActiveUserById(ctx.actor.ownerUserId!);
      const items = await listNotificationSubscriptions(owner.id);

      return NextResponse.json({ items, count: items.length }, { status: 200 });
    },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint: "POST /api/v1/ext/notification-subscriptions",
      method: "POST",
      allowGlobalActorWithoutProject: true,
      auditProjectId: null,
      db,
    },
    async (ctx) => {
      const refused = refuseNonPersonal(ctx);

      if (refused) return refused;

      const owner = await requireActiveUserById(ctx.actor.ownerUserId!);

      let body: unknown;

      try {
        body = await req.json();
      } catch {
        return NextResponse.json(
          { code: "PRECONDITION", message: "body must be JSON" },
          { status: 400 },
        );
      }

      try {
        const input = validateSubscriptionInput(body);
        const created = await upsertNotificationSubscription(owner.id, input);

        return NextResponse.json(created, { status: 201 });
      } catch (err) {
        if (isMaisterError(err) && err.code === "CONFIG") {
          return NextResponse.json(
            { code: err.code, message: err.message },
            { status: 422 },
          );
        }

        throw err;
      }
    },
  );
}
