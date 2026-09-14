import "server-only";

/**
 * Per-user notification subscriptions and push endpoints (ADR-173 D9,
 * `NTF-06`, `NTF-07`).
 *
 * EVERY function here takes the owner as its FIRST argument, resolved by the
 * caller from `auth-context`. There is no function that accepts an owner from a
 * request body, because D9's rule is only enforceable if the unsafe shape does
 * not exist: an unknown id answers "not found" rather than "forbidden", so the
 * API never confirms that another user's row exists.
 */

import type {
  AttentionNotificationType,
  NotificationSubscriptionRow,
  NotificationTransport,
} from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import {
  ATTENTION_NOTIFICATION_TYPES,
  notificationSubscriptions,
  NOTIFICATION_TRANSPORTS,
  pushSubscriptions,
} from "@/lib/db/schema";
import {
  createSubscription,
  listSubscriptions,
  type SubscriptionScope,
  updateSubscription,
} from "@/lib/webhooks/subscriptions";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants, as elsewhere in lib/queries.
type Db = any;

const log = pino({
  name: "notifications-subscriptions",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface NotificationSubscriptionDto {
  id: string;
  eventTypes: AttentionNotificationType[];
  transport: NotificationTransport;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationSubscriptionInput {
  eventTypes: AttentionNotificationType[];
  transport: NotificationTransport;
  enabled?: boolean;
  /**
   * Required when `transport` is `webhook` and meaningless otherwise: the
   * destination the four `attention.*` events are POSTed to, and the `env:NAME`
   * reference the body is signed with. A secret VALUE never appears here.
   */
  webhook?: WebhookTargetInput;
}

export interface WebhookTargetInput {
  url: string;
  signingSecretRef: string;
}

/**
 * The name every personal target carries. A person does not name their own
 * notification endpoint — there is exactly one, and the admin surfaces that
 * would read a name never see a user-scoped row.
 */
const PERSONAL_TARGET_NAME = "Personal notifications";

const TYPE_SET: ReadonlySet<string> = new Set(ATTENTION_NOTIFICATION_TYPES);
const TRANSPORT_SET: ReadonlySet<string> = new Set(NOTIFICATION_TRANSPORTS);

function toDto(row: NotificationSubscriptionRow): NotificationSubscriptionDto {
  return {
    id: row.id,
    eventTypes: row.eventTypes,
    transport: row.transport,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `NTF-08` at the API edge. The four `attention.*` types are the only ones a
 * subscription may name; anything else — including a real webhook event type
 * like `run.done` — is refused `CONFIG`, because a per-event subscription is the
 * fatigue anti-pattern the decision forbids rather than a configuration the
 * product supports.
 */
export function validateSubscriptionInput(
  input: unknown,
): NotificationSubscriptionInput {
  const body = (input ?? {}) as Record<string, unknown>;

  if ("ownerUserId" in body || "owner" in body || "userId" in body) {
    // D9: refused, not ignored. Silently dropping it would let a caller believe
    // they had set an owner.
    throw new MaisterError(
      "CONFIG",
      "owner comes from the authenticated context; remove it from the body",
    );
  }

  const transport = body.transport;

  if (typeof transport !== "string" || !TRANSPORT_SET.has(transport)) {
    throw new MaisterError(
      "CONFIG",
      `transport must be one of ${NOTIFICATION_TRANSPORTS.join(" | ")}`,
    );
  }

  const types = body.eventTypes;

  if (!Array.isArray(types) || types.length === 0) {
    throw new MaisterError("CONFIG", "eventTypes must be a non-empty array");
  }

  const unknown = types.filter(
    (t) => typeof t !== "string" || !TYPE_SET.has(t),
  );

  if (unknown.length > 0) {
    throw new MaisterError(
      "CONFIG",
      `eventTypes may only name ${ATTENTION_NOTIFICATION_TYPES.join(" | ")}`,
    );
  }

  const enabled = body.enabled;

  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new MaisterError("CONFIG", "enabled must be a boolean");
  }

  return {
    // De-duplicated and ordered by the canonical list, so two equivalent
    // requests store byte-identical rows.
    eventTypes: ATTENTION_NOTIFICATION_TYPES.filter((t) =>
      (types as string[]).includes(t),
    ) as AttentionNotificationType[],
    transport: transport as NotificationTransport,
    enabled,
    webhook: parseWebhookTarget(transport, body.webhook),
  };
}

/**
 * A `webhook` intent without a destination is an intent nothing can honour, so
 * the destination is REQUIRED at the edge rather than discovered to be missing
 * at fan-out. Only the shape is checked here: the URL's egress policy
 * (ADR-077) and the `env:NAME` rule belong to the webhook service, which
 * enforces them for every writer rather than for this one.
 */
function parseWebhookTarget(
  transport: string,
  raw: unknown,
): WebhookTargetInput | undefined {
  if (transport !== "webhook") {
    if (raw !== undefined) {
      throw new MaisterError(
        "CONFIG",
        "webhook is only meaningful for transport 'webhook'",
      );
    }

    return undefined;
  }

  const target = (raw ?? {}) as Record<string, unknown>;

  if (typeof target.url !== "string" || target.url.length === 0) {
    throw new MaisterError(
      "CONFIG",
      "transport 'webhook' requires webhook.url",
    );
  }
  if (
    typeof target.signingSecretRef !== "string" ||
    target.signingSecretRef.length === 0
  ) {
    throw new MaisterError(
      "CONFIG",
      "transport 'webhook' requires webhook.signingSecretRef",
    );
  }

  return { url: target.url, signingSecretRef: target.signingSecretRef };
}

export async function listNotificationSubscriptions(
  ownerUserId: string,
  db?: Db,
): Promise<NotificationSubscriptionDto[]> {
  const client: Db = db ?? getDb();
  const rows = (await client
    .select()
    .from(notificationSubscriptions)
    .where(eq(notificationSubscriptions.ownerUserId, ownerUserId))
    .orderBy(
      notificationSubscriptions.transport,
    )) as NotificationSubscriptionRow[];

  return rows.map(toDto);
}

/**
 * Upsert on `(owner, transport)`: one intent per transport, so a second POST for
 * the same transport REPLACES rather than conflicting. A reader toggling their
 * preferences should not have to discover whether a row already exists.
 */
export async function upsertNotificationSubscription(
  ownerUserId: string,
  input: NotificationSubscriptionInput,
  db?: Db,
): Promise<NotificationSubscriptionDto> {
  const client: Db = db ?? getDb();
  const [row] = (await client
    .insert(notificationSubscriptions)
    .values({
      id: randomUUID(),
      ownerUserId,
      transport: input.transport,
      eventTypes: input.eventTypes,
      enabled: input.enabled ?? true,
    })
    .onConflictDoUpdate({
      target: [
        notificationSubscriptions.ownerUserId,
        notificationSubscriptions.transport,
      ],
      set: {
        eventTypes: input.eventTypes,
        enabled: input.enabled ?? true,
        updatedAt: new Date(),
      },
    })
    .returning()) as NotificationSubscriptionRow[];

  log.info(
    { ownerUserId, transport: input.transport, id: row.id },
    "notification subscription upserted",
  );

  return toDto(row);
}

/**
 * `NTF-07`: another owner's id is indistinguishable from a nonexistent one.
 *
 * A patch that LANDS on `webhook` writes the delivery target in the same
 * transaction, because an intent that survives an edit without one is the same
 * undeliverable row the create path used to produce.
 */
export async function updateNotificationSubscription(
  ownerUserId: string,
  id: string,
  input: NotificationSubscriptionInput,
  db?: Db,
): Promise<NotificationSubscriptionDto | null> {
  const client: Db = db ?? getDb();

  return client.transaction(async (tx: Db) => {
    const rows = (await tx
      .update(notificationSubscriptions)
      .set({
        eventTypes: input.eventTypes,
        transport: input.transport,
        enabled: input.enabled ?? true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(notificationSubscriptions.id, id),
          eq(notificationSubscriptions.ownerUserId, ownerUserId),
        ),
      )
      .returning()) as NotificationSubscriptionRow[];

    if (!rows[0]) return null;
    if (input.transport === "webhook") {
      await writeWebhookTarget(tx, ownerUserId, input);
    }

    return toDto(rows[0]);
  });
}

export async function deleteNotificationSubscription(
  ownerUserId: string,
  id: string,
  db?: Db,
): Promise<boolean> {
  const client: Db = db ?? getDb();
  const rows = (await client
    .delete(notificationSubscriptions)
    .where(
      and(
        eq(notificationSubscriptions.id, id),
        eq(notificationSubscriptions.ownerUserId, ownerUserId),
      ),
    )
    .returning({ id: notificationSubscriptions.id })) as Array<{ id: string }>;

  return rows.length > 0;
}

export interface PushEndpointInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime?: number | null;
}

/**
 * Registers a browser push endpoint. Idempotent on `(owner, endpoint)` — the
 * same browser re-subscribing after a service-worker update must not accumulate
 * rows, or one notification would arrive several times.
 *
 * `endpoint` and the keys are stored OPAQUE: never parsed for routing, never
 * used to derive a host, never logged.
 */
export async function registerPushEndpoint(
  ownerUserId: string,
  input: PushEndpointInput,
  db?: Db,
): Promise<{ id: string }> {
  const client: Db = db ?? getDb();
  const [row] = (await client
    .insert(pushSubscriptions)
    .values({
      id: randomUUID(),
      ownerUserId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      expirationTime: input.expirationTime ?? null,
    })
    .onConflictDoUpdate({
      target: [pushSubscriptions.ownerUserId, pushSubscriptions.endpoint],
      set: {
        p256dh: input.p256dh,
        auth: input.auth,
        expirationTime: input.expirationTime ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: pushSubscriptions.id })) as Array<{ id: string }>;

  // The endpoint is a bearer capability for pushing to that browser; only the
  // row id is ever logged.
  log.info(
    { ownerUserId, pushSubscriptionId: row.id },
    "push endpoint registered",
  );

  return row;
}

/**
 * Register this browser AND record that its owner wants web push (`NTF-04`).
 *
 * Fan-out needs BOTH rows: `push_subscriptions` says where to send, and an
 * enabled `notification_subscriptions` row for `web_push` says whether to send
 * at all. The account panel has one "Enable" control, so creating only the
 * endpoint left every UI opt-in silently undeliverable — the endpoint existed,
 * the intent never did, and the `EXISTS` in the fanout query matched nothing.
 *
 * The intent names all four `attention.*` types, which is the ENTIRE permitted
 * surface: ADR-173 D6 already caps triggers at decision deltas plus the digest,
 * so this is not a broad default, it is the only one the decision allows.
 *
 * One transaction: a half-enabled opt-in is the state this function exists to
 * make unrepresentable. Re-enabling is idempotent — the endpoint upserts on
 * `(owner, endpoint)` and the intent on `(owner, transport)`.
 */
export async function enablePushForOwner(
  ownerUserId: string,
  input: PushEndpointInput,
  db?: Db,
): Promise<{ id: string }> {
  const client: Db = db ?? getDb();

  return client.transaction(async (tx: Db) => {
    const registered = await registerPushEndpoint(ownerUserId, input, tx);

    await upsertNotificationSubscription(
      ownerUserId,
      {
        eventTypes: [...ATTENTION_NOTIFICATION_TYPES],
        transport: "web_push",
        enabled: true,
      },
      tx,
    );

    return registered;
  });
}

/**
 * The delivery TARGET a `webhook` intent names, written from the same input as
 * the intent itself.
 *
 * The HTTP fan-out matches on `webhook_subscriptions.event_types`, not on the
 * intent — so if the two were written separately they would be free to
 * disagree, and the caller's selected types would be silently overridden by
 * whatever the target happened to carry. One writer, one transaction, and the
 * question "which types does this person actually receive?" has one answer.
 *
 * ONE personal target per owner, updated in place rather than replaced: the
 * per-subscription delivery ledger is append-only audit, and a delete would
 * cascade it away on every settings change.
 */
async function writeWebhookTarget(
  tx: Db,
  ownerUserId: string,
  input: NotificationSubscriptionInput,
): Promise<void> {
  if (input.webhook === undefined) {
    throw new MaisterError(
      "CONFIG",
      "transport 'webhook' requires a webhook target",
    );
  }

  const scope: SubscriptionScope = { projectId: null, ownerUserId };
  const [existing] = await listSubscriptions(scope, tx);
  const enabled = input.enabled ?? true;

  if (existing) {
    await updateSubscription(
      scope,
      existing.id,
      {
        url: input.webhook.url,
        signing_secret_ref: input.webhook.signingSecretRef,
        event_types: [...input.eventTypes],
        enabled,
      },
      tx,
    );

    return;
  }

  await createSubscription(
    scope,
    {
      name: PERSONAL_TARGET_NAME,
      url: input.webhook.url,
      event_types: [...input.eventTypes],
      signing_secret_ref: input.webhook.signingSecretRef,
      enabled,
    },
    tx,
  );
}

/**
 * The HTTP half of ADR-173's `web_push | webhook` axis, and the exact mirror of
 * `enablePushForOwner` above.
 *
 * A `webhook` intent names a transport whose target lives in
 * `webhook_subscriptions`, and only a row carrying `owner_user_id` is ever
 * paired with a user-scoped `attention.*` event (`subscriptionMatches`). No
 * production path wrote that column, so an accepted `webhook` intent answered
 * 201 and then delivered nothing, forever — an intent the engine could not
 * honour. Target and intent are therefore created TOGETHER, in one transaction,
 * for the same reason the push pair is.
 */
export async function enableWebhookForOwner(
  ownerUserId: string,
  input: NotificationSubscriptionInput,
  db?: Db,
): Promise<NotificationSubscriptionDto> {
  const client: Db = db ?? getDb();

  return client.transaction(async (tx: Db) => {
    await writeWebhookTarget(tx, ownerUserId, input);

    return upsertNotificationSubscription(ownerUserId, input, tx);
  });
}

export async function deletePushEndpoint(
  ownerUserId: string,
  endpoint: string,
  db?: Db,
): Promise<boolean> {
  const client: Db = db ?? getDb();
  const rows = (await client
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.ownerUserId, ownerUserId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    )
    .returning({ id: pushSubscriptions.id })) as Array<{ id: string }>;

  return rows.length > 0;
}

export async function countPushEndpoints(
  ownerUserId: string,
  db?: Db,
): Promise<number> {
  const client: Db = db ?? getDb();
  const rows = (await client
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.ownerUserId, ownerUserId))) as Array<{
    id: string;
  }>;

  return rows.length;
}
