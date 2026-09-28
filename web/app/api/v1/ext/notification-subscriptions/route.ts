import "server-only";

/**
 * `GET|POST /api/v1/ext/notification-subscriptions` (ADR-173 D9, `NTF-07`).
 *
 * Scope `notifications:subscriptions`. The owner comes from `auth-context` and
 * nowhere else: there is no parameter naming a user, and a body that names one
 * is REFUSED rather than ignored — silently dropping it would let a caller
 * believe they had set an owner.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  enableWebhookForOwner,
  listNotificationSubscriptions,
  upsertNotificationSubscription,
  validateSubscriptionInput,
} from "@/lib/notifications/subscriptions";
import { getDb } from "@/lib/db/client";
import { handleExt } from "@/lib/tokens/ext-handler";
import { requirePersonalOrLibrarianActor } from "@/lib/tokens/personal-actor";
import { isMaisterError } from "@/lib/errors";
import { requireActiveUserById } from "@/lib/authz";

const SCOPE = "notifications:subscriptions";

// A notification subscription is a PERSON's, and a librarian must never change
// where its owner is told (ADR-173 D10, ADR-186).
function refuseNonPersonal(ctx: {
  actor: Parameters<typeof requirePersonalOrLibrarianActor>[0];
}): NextResponse | null {
  return requirePersonalOrLibrarianActor(ctx.actor, { allowLibrarian: false });
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
        // A `webhook` intent must arrive with its delivery target, and the two
        // are written in ONE transaction — an intent with no reachable target
        // is a 201 that promises a notification nothing can send.
        const created =
          input.transport === "webhook"
            ? await enableWebhookForOwner(owner.id, input)
            : await upsertNotificationSubscription(owner.id, input);

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
