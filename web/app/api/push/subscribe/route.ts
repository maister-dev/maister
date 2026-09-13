import "server-only";

/**
 * `POST /api/push/subscribe` — register this browser's push endpoint
 * (ADR-173 D9/D11, `NTF-10`).
 *
 * Session-authenticated, not token-authenticated: it is called by the opt-in UI
 * from the reader's own browser. The owner is the session user and is never read
 * from the body.
 *
 * `endpoint` and `keys` are body-controlled and stored OPAQUE — never parsed for
 * routing, never used to derive a host, never logged. With VAPID unconfigured
 * this refuses `CONFIG` rather than storing an endpoint nothing can ever push to.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  isPushConfigured,
  pushUnavailableReason,
} from "@/lib/notifications/vapid";
import { httpStatusForAuthz, requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import {
  deletePushEndpoint,
  enablePushForOwner,
} from "@/lib/notifications/subscriptions";
import { assertAllowedDestinationUrl } from "@/lib/webhooks/destination";

const bodySchema = z
  .object({
    endpoint: z.string().url().max(2000),
    expirationTime: z.number().int().nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().min(1).max(500),
        auth: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

export async function POST(req: NextRequest): Promise<NextResponse> {
  let userId: string;

  try {
    userId = (await requireActiveSession()).id;
  } catch (err) {
    const code = isMaisterError(err) ? err.code : "CRASH";

    return NextResponse.json(
      { code, message: isMaisterError(err) ? err.message : "internal error" },
      {
        status: isMaisterError(err)
          ? (httpStatusForAuthz(err.code) ?? 403)
          : 500,
      },
    );
  }

  if (!isPushConfigured()) {
    // NTF-10: the deployment boots and works without VAPID; this one route is
    // where "push unavailable" becomes visible to a caller.
    return NextResponse.json(
      {
        code: "CONFIG",
        message: pushUnavailableReason() ?? "push unavailable",
      },
      { status: 400 },
    );
  }

  let parsed: z.infer<typeof bodySchema>;

  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { code: "PRECONDITION", message: "invalid push subscription body" },
      { status: 400 },
    );
  }

  try {
    // Egress policy at the API edge (ADR-077), the same guard a webhook
    // destination gets at creation. The send-time check in `push-sender.ts` is
    // what closes DNS rebinding; this refuses the obvious case before a row
    // with a private-address endpoint ever lands.
    assertAllowedDestinationUrl(new URL(parsed.endpoint));
  } catch (err) {
    return NextResponse.json(
      {
        code: "CONFIG",
        message: isMaisterError(err) ? err.message : "blocked push destination",
      },
      { status: 400 },
    );
  }

  // Registering a browser and WANTING to be notified are one action from the
  // reader's point of view — the panel has a single "Enable" control. Fan-out
  // needs both rows, so the endpoint and the intent are created together or the
  // opt-in silently delivers nothing.
  const { id } = await enablePushForOwner(userId, {
    endpoint: parsed.endpoint,
    p256dh: parsed.keys.p256dh,
    auth: parsed.keys.auth,
    expirationTime: parsed.expirationTime ?? null,
  });

  return NextResponse.json({ id }, { status: 201 });
}

/**
 * Unregister this browser. The caller has already told the browser to
 * unsubscribe, so the endpoint is dead either way — this removes the row so the
 * sender stops attempting it, rather than waiting for the first `410 Gone`.
 *
 * The owner is the session user: an endpoint string is not a capability to
 * delete somebody else's row.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  let userId: string;

  try {
    userId = (await requireActiveSession()).id;
  } catch (err) {
    const code = isMaisterError(err) ? err.code : "CRASH";

    return NextResponse.json(
      { code, message: isMaisterError(err) ? err.message : "internal error" },
      {
        status: isMaisterError(err)
          ? (httpStatusForAuthz(err.code) ?? 403)
          : 500,
      },
    );
  }

  let endpoint: string;

  try {
    endpoint = z
      .object({ endpoint: z.string().url().max(2000) })
      .strict()
      .parse(await req.json()).endpoint;
  } catch {
    return NextResponse.json(
      { code: "PRECONDITION", message: "endpoint is required" },
      { status: 400 },
    );
  }

  // Absent is success: the reader asked for "not subscribed here", and they are.
  await deletePushEndpoint(userId, endpoint);

  return new NextResponse(null, { status: 204 });
}
