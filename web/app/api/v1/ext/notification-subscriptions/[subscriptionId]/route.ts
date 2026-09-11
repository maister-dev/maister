import "server-only";

/**
 * `PATCH|DELETE /api/v1/ext/notification-subscriptions/{subscriptionId}`
 * (ADR-172 D9, `NTF-07`).
 *
 * A subscription owned by another user answers **404, never 403**: a 403 would
 * confirm that the row exists, which is a disclosure about somebody else's
 * account. The store makes that the only reachable answer by scoping every
 * mutation on `(id, owner)` rather than checking ownership after a read.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  deleteNotificationSubscription,
  updateNotificationSubscription,
  validateSubscriptionInput,
} from "@/lib/notifications/subscriptions";
import { getDb } from "@/lib/db/client";
import { handleExt } from "@/lib/tokens/ext-handler";
import { isMaisterError } from "@/lib/errors";
import { requireActiveUserById } from "@/lib/authz";

const SCOPE = "notifications:subscriptions";

const NOT_FOUND = {
  code: "CONFLICT",
  message: "notification subscription not found",
} as const;

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

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ subscriptionId: string }> },
): Promise<NextResponse> {
  const db = getDb();
  const { subscriptionId } = await context.params;

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint: "PATCH /api/v1/ext/notification-subscriptions/[subscriptionId]",
      method: "PATCH",
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
        const updated = await updateNotificationSubscription(
          owner.id,
          subscriptionId,
          input,
        );

        if (!updated) return NextResponse.json(NOT_FOUND, { status: 404 });

        return NextResponse.json(updated, { status: 200 });
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

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ subscriptionId: string }> },
): Promise<NextResponse> {
  const db = getDb();
  const { subscriptionId } = await context.params;

  return handleExt(
    req,
    {
      scopeLabel: SCOPE,
      endpoint:
        "DELETE /api/v1/ext/notification-subscriptions/[subscriptionId]",
      method: "DELETE",
      allowGlobalActorWithoutProject: true,
      auditProjectId: null,
      db,
    },
    async (ctx) => {
      const refused = refuseNonPersonal(ctx);

      if (refused) return refused;

      const owner = await requireActiveUserById(ctx.actor.ownerUserId!);
      const deleted = await deleteNotificationSubscription(
        owner.id,
        subscriptionId,
      );

      if (!deleted) return NextResponse.json(NOT_FOUND, { status: 404 });

      return new NextResponse(null, { status: 204 });
    },
  );
}
