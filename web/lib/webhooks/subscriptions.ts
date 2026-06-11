import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import pino from "pino";

import { isWebhookEventType } from "./taxonomy";
import { isEnvRef } from "./signing";

import { getDb } from "@/lib/db/client";
import {
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEvents,
  webhookSubscriptions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union. Mirrors
// replay.ts / ping.ts / outbox.ts so the handle rides an optional caller tx.
type Db = any;

const log = pino({
  name: "webhooks-subscriptions",
  level: process.env.LOG_LEVEL ?? "info",
});

// Platform scope = { projectId: null }. Project scope = { projectId: <uuid> }.
// Every read/write is scoped so the same service backs both the platform-admin
// routes (T11) and the project routes (T12) without leaking across the boundary.
export interface SubscriptionScope {
  projectId: string | null;
}

// Wire DTO. Mixed casing is intentional and matches the OpenAPI
// `WebhookSubscription` schema 1:1: snake_case for the secret-ref / event_types
// fields, camelCase for the rest. A secret VALUE is NEVER part of this shape —
// only the `env:NAME` reference strings.
export interface WebhookSubscriptionDto {
  id: string;
  projectId: string | null;
  name: string;
  url: string;
  method: "POST" | "PUT";
  headers: Record<string, string>;
  event_types: string[];
  signing_secret_ref: string;
  secondary_signing_secret_ref: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastDelivery: { status: string; at: Date } | null;
}

export interface CreateSubscriptionInput {
  name: string;
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  event_types: string[];
  signing_secret_ref: string;
  secondary_signing_secret_ref?: string | null;
  enabled?: boolean;
}

export interface UpdateSubscriptionPatch {
  name?: string;
  url?: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  event_types?: string[];
  signing_secret_ref?: string;
  secondary_signing_secret_ref?: string | null;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Validation. Every failure is CONFIG (→ 422 at the route). Secret refs MUST be
// `env:NAME`; a raw value or a bare name is rejected so a plaintext secret can
// never reach the row.
// ---------------------------------------------------------------------------
function assertUrl(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new MaisterError("CONFIG", `webhook url "${url}" is not a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MaisterError(
      "CONFIG",
      `webhook url "${url}" must be http or https`,
    );
  }
}

function assertSecretRef(field: string, ref: string): void {
  if (!isEnvRef(ref)) {
    throw new MaisterError(
      "CONFIG",
      `webhook ${field} must be an env:NAME reference, not a value`,
    );
  }
}

function assertEventTypes(eventTypes: string[]): void {
  if (eventTypes.length === 0) {
    throw new MaisterError("CONFIG", "webhook event_types must not be empty");
  }

  for (const t of eventTypes) {
    if (t !== "*" && !isWebhookEventType(t)) {
      throw new MaisterError(
        "CONFIG",
        `webhook event_types entry "${t}" is not a known event type`,
      );
    }
  }
}

function assertMethod(method: string): void {
  if (method !== "POST" && method !== "PUT") {
    throw new MaisterError(
      "CONFIG",
      `webhook method "${method}" must be POST or PUT`,
    );
  }
}

// Header values may be an env:NAME ref OR a literal. A ref is left as-is (never
// resolved here); a literal is stored verbatim. Both are safe to echo back.
function assertHeaders(headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") {
      throw new MaisterError(
        "CONFIG",
        `webhook header "${k}" value must be a string`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Row → DTO. `lastDelivery` is a per-call summary (latest delivery by created_at).
// ---------------------------------------------------------------------------
interface LastDeliverySummary {
  status: string;
  at: Date;
}

async function loadLastDelivery(
  handle: Db,
  subscriptionId: string,
): Promise<LastDeliverySummary | null> {
  const r = await handle.execute(sql`
    SELECT status, updated_at
    FROM webhook_deliveries
    WHERE subscription_id = ${subscriptionId}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = (r.rows ?? [])[0] as
    | { status: string; updated_at: Date }
    | undefined;

  if (!row) return null;

  return { status: row.status, at: new Date(row.updated_at) };
}

async function toDto(handle: Db, row: any): Promise<WebhookSubscriptionDto> {
  return {
    id: row.id,
    projectId: row.projectId ?? null,
    name: row.name,
    url: row.url,
    method: row.method,
    headers: row.headers ?? {},
    event_types: row.eventTypes ?? [],
    signing_secret_ref: row.signingSecretRef,
    secondary_signing_secret_ref: row.secondarySigningSecretRef ?? null,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastDelivery: await loadLastDelivery(handle, row.id),
  };
}

function scopeFilter(scope: SubscriptionScope) {
  return scope.projectId === null
    ? isNull(webhookSubscriptions.projectId)
    : eq(webhookSubscriptions.projectId, scope.projectId);
}

async function loadRow(
  handle: Db,
  scope: SubscriptionScope,
  id: string,
): Promise<any | undefined> {
  const rows = await handle
    .select()
    .from(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, id), scopeFilter(scope)));

  return rows[0];
}

// ---------------------------------------------------------------------------
// CRUD.
// ---------------------------------------------------------------------------
export async function createSubscription(
  scope: SubscriptionScope,
  input: CreateSubscriptionInput,
  db?: Db,
): Promise<WebhookSubscriptionDto> {
  const handle: Db = db ?? getDb();

  assertUrl(input.url);
  assertSecretRef("signing_secret_ref", input.signing_secret_ref);

  if (
    input.secondary_signing_secret_ref !== undefined &&
    input.secondary_signing_secret_ref !== null
  ) {
    assertSecretRef(
      "secondary_signing_secret_ref",
      input.secondary_signing_secret_ref,
    );
  }

  assertEventTypes(input.event_types);

  if (input.method !== undefined) assertMethod(input.method);
  if (input.headers !== undefined) assertHeaders(input.headers);

  const id = randomUUID();

  const inserted = await handle
    .insert(webhookSubscriptions)
    .values({
      id,
      projectId: scope.projectId,
      name: input.name,
      url: input.url,
      method: input.method ?? "POST",
      headers: input.headers ?? {},
      eventTypes: input.event_types,
      signingSecretRef: input.signing_secret_ref,
      secondarySigningSecretRef: input.secondary_signing_secret_ref ?? null,
      enabled: input.enabled ?? true,
    })
    .returning();

  log.debug(
    { id, projectId: scope.projectId },
    "[webhooks.subscriptions] created",
  );

  return toDto(handle, inserted[0]);
}

export async function listSubscriptions(
  scope: SubscriptionScope,
  db?: Db,
): Promise<WebhookSubscriptionDto[]> {
  const handle: Db = db ?? getDb();

  const rows = await handle
    .select()
    .from(webhookSubscriptions)
    .where(scopeFilter(scope))
    .orderBy(desc(webhookSubscriptions.createdAt));

  return Promise.all(rows.map((row: any) => toDto(handle, row)));
}

export async function getSubscription(
  scope: SubscriptionScope,
  id: string,
  db?: Db,
): Promise<WebhookSubscriptionDto | null> {
  const handle: Db = db ?? getDb();
  const row = await loadRow(handle, scope, id);

  if (!row) return null;

  return toDto(handle, row);
}

export async function updateSubscription(
  scope: SubscriptionScope,
  id: string,
  patch: UpdateSubscriptionPatch,
  db?: Db,
): Promise<WebhookSubscriptionDto | null> {
  const handle: Db = db ?? getDb();
  const current = await loadRow(handle, scope, id);

  if (!current) return null;

  if (patch.url !== undefined) assertUrl(patch.url);
  if (patch.signing_secret_ref !== undefined) {
    assertSecretRef("signing_secret_ref", patch.signing_secret_ref);
  }
  if (
    patch.secondary_signing_secret_ref !== undefined &&
    patch.secondary_signing_secret_ref !== null
  ) {
    assertSecretRef(
      "secondary_signing_secret_ref",
      patch.secondary_signing_secret_ref,
    );
  }
  if (patch.event_types !== undefined) assertEventTypes(patch.event_types);
  if (patch.method !== undefined) assertMethod(patch.method);
  if (patch.headers !== undefined) assertHeaders(patch.headers);

  const set: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.name !== undefined) set.name = patch.name;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.method !== undefined) set.method = patch.method;
  if (patch.headers !== undefined) set.headers = patch.headers;
  if (patch.event_types !== undefined) set.eventTypes = patch.event_types;
  if (patch.signing_secret_ref !== undefined) {
    set.signingSecretRef = patch.signing_secret_ref;
  }
  if (patch.secondary_signing_secret_ref !== undefined) {
    set.secondarySigningSecretRef = patch.secondary_signing_secret_ref;
  }
  if (patch.enabled !== undefined) set.enabled = patch.enabled;

  await handle
    .update(webhookSubscriptions)
    .set(set)
    .where(and(eq(webhookSubscriptions.id, id), scopeFilter(scope)));

  const updated = await loadRow(handle, scope, id);

  return toDto(handle, updated);
}

// Usage-guarded hard delete: the per-subscription delivery/attempt ledger is
// append-only audit, so a subscription with ANY delivery history is refused
// (CONFLICT → 409); disable it instead. Only a never-delivered subscription
// hard-deletes.
export async function deleteSubscription(
  scope: SubscriptionScope,
  id: string,
  db?: Db,
): Promise<boolean> {
  const handle: Db = db ?? getDb();
  const current = await loadRow(handle, scope, id);

  if (!current) return false;

  const used = await handle.execute(sql`
    SELECT 1 FROM webhook_deliveries WHERE subscription_id = ${id} LIMIT 1
  `);

  if ((used.rows ?? []).length > 0) {
    throw new MaisterError(
      "CONFLICT",
      `webhook subscription ${id} has delivery history and cannot be deleted; disable it instead`,
    );
  }

  await handle
    .delete(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, id), scopeFilter(scope)));

  log.info(
    { id, projectId: scope.projectId },
    "[webhooks.subscriptions] deleted",
  );

  return true;
}

// ---------------------------------------------------------------------------
// Delivery log. Newest-first cursor paging; each delivery carries its full
// attempts[] audit trail (attempt_no order). The cursor encodes createdAt+id so
// it is stable across equal timestamps.
// ---------------------------------------------------------------------------
export interface DeliveryAttemptDto {
  attemptNo: number;
  requestedAt: Date;
  durationMs: number;
  httpStatus: number | null;
  errorKind: string | null;
  responseSnippet: string | null;
}

export interface DeliveryDto {
  id: string;
  eventId: string;
  type: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastHttpStatus: number | null;
  lastErrorKind: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  attempts: DeliveryAttemptDto[];
}

export interface ListDeliveriesPage {
  deliveries: DeliveryDto[];
  nextCursor: string | null;
}

export interface ListDeliveriesOptions {
  cursor?: string;
  limit?: number;
}

const DEFAULT_DELIVERY_LIMIT = 50;
const MAX_DELIVERY_LIMIT = 200;

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");

    if (sep < 0) return null;

    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);

    if (Number.isNaN(createdAt.getTime()) || !id) return null;

    return { createdAt, id };
  } catch {
    return null;
  }
}

async function loadAttempts(
  handle: Db,
  deliveryIds: string[],
): Promise<Map<string, DeliveryAttemptDto[]>> {
  const byDelivery = new Map<string, DeliveryAttemptDto[]>();

  if (deliveryIds.length === 0) return byDelivery;

  const rows = await handle
    .select()
    .from(webhookDeliveryAttempts)
    .where(inArray(webhookDeliveryAttempts.deliveryId, deliveryIds))
    .orderBy(webhookDeliveryAttempts.attemptNo);

  for (const a of rows as any[]) {
    const list = byDelivery.get(a.deliveryId) ?? [];

    list.push({
      attemptNo: a.attemptNo,
      requestedAt: a.requestedAt,
      durationMs: a.durationMs,
      httpStatus: a.httpStatus ?? null,
      errorKind: a.errorKind ?? null,
      responseSnippet: a.responseSnippet ?? null,
    });
    byDelivery.set(a.deliveryId, list);
  }

  return byDelivery;
}

// Server-state ownership join: does `deliveryId` belong to subscription
// `subscriptionId`, AND is that subscription in `scope`? The replay/inspection
// routes call this BEFORE acting so a cross-subscription (or cross-scope)
// delivery id is a 404, never a leaked 409/200. project_id IS NULL ↔ platform.
export async function deliveryBelongsToScopedSubscription(
  scope: SubscriptionScope,
  subscriptionId: string,
  deliveryId: string,
  db?: Db,
): Promise<boolean> {
  const handle: Db = db ?? getDb();
  const scopeSql =
    scope.projectId === null
      ? sql`s.project_id IS NULL`
      : sql`s.project_id = ${scope.projectId}`;
  const r = await handle.execute(sql`
    SELECT 1
    FROM webhook_deliveries d
    JOIN webhook_subscriptions s ON s.id = d.subscription_id
    WHERE d.id = ${deliveryId}
      AND d.subscription_id = ${subscriptionId}
      AND ${scopeSql}
    LIMIT 1
  `);

  return (r.rows ?? []).length > 0;
}

// Self-scoping: the rows are filtered by subscription_id AND a JOIN-equivalent
// scope predicate on the owning subscription (project_id IS NULL for platform,
// = scope.projectId for a project). A subscriptionId outside `scope` returns an
// empty page — never another scope's deliveries. The route still 404-guards the
// subscription first; this is defense-in-depth for the shared (T12) service.
export async function listDeliveries(
  scope: SubscriptionScope,
  subscriptionId: string,
  options: ListDeliveriesOptions,
  db?: Db,
): Promise<ListDeliveriesPage> {
  const handle: Db = db ?? getDb();
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_DELIVERY_LIMIT, 1),
    MAX_DELIVERY_LIMIT,
  );
  const decoded = options.cursor ? decodeCursor(options.cursor) : null;

  const scopeProjectSql =
    scope.projectId === null
      ? sql`s.project_id IS NULL`
      : sql`s.project_id = ${scope.projectId}`;
  const scopedOwnership = sql`
    ${webhookDeliveries.subscriptionId} = ${subscriptionId}
    AND EXISTS (
      SELECT 1 FROM webhook_subscriptions s
      WHERE s.id = ${webhookDeliveries.subscriptionId}
        AND ${scopeProjectSql}
    )
  `;
  const where = decoded
    ? and(
        scopedOwnership,
        or(
          lt(webhookDeliveries.createdAt, decoded.createdAt),
          and(
            eq(webhookDeliveries.createdAt, decoded.createdAt),
            lt(webhookDeliveries.id, decoded.id),
          ),
        ),
      )
    : scopedOwnership;

  const rows = (await handle
    .select()
    .from(webhookDeliveries)
    .where(where)
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit + 1)) as any[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const attempts = await loadAttempts(
    handle,
    page.map((r) => r.id),
  );

  const deliveries: DeliveryDto[] = page.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    type: "",
    status: r.status,
    attemptCount: r.attemptCount,
    nextAttemptAt: r.status === "pending" ? (r.nextAttemptAt ?? null) : null,
    lastHttpStatus: r.lastHttpStatus ?? null,
    lastErrorKind: r.lastErrorKind ?? null,
    deliveredAt: r.deliveredAt ?? null,
    createdAt: r.createdAt,
    attempts: attempts.get(r.id) ?? [],
  }));

  // Resolve the originating event type per delivery (the wire DTO carries it).
  if (deliveries.length > 0) {
    const eventIds = Array.from(new Set(deliveries.map((d) => d.eventId)));
    const eventRows = (await handle
      .select({ id: webhookEvents.id, type: webhookEvents.type })
      .from(webhookEvents)
      .where(inArray(webhookEvents.id, eventIds))) as Array<{
      id: string;
      type: string;
    }>;
    const typeById = new Map(eventRows.map((e) => [e.id, e.type]));

    for (const d of deliveries) d.type = typeById.get(d.eventId) ?? "";
  }

  const last = page[page.length - 1];
  const nextCursor = hasMore ? encodeCursor(last.createdAt, last.id) : null;

  return { deliveries, nextCursor };
}

// ---------------------------------------------------------------------------
// Settings — the global outbound-webhooks kill-switch on the
// platform_runtime_settings singleton (id = 'singleton').
// ---------------------------------------------------------------------------
export interface WebhookSettings {
  enabled: boolean;
}

export async function getWebhookSettings(db?: Db): Promise<WebhookSettings> {
  const handle: Db = db ?? getDb();
  const r = await handle.execute(sql`
    SELECT webhooks_enabled FROM platform_runtime_settings WHERE id = 'singleton'
  `);
  const row = (r.rows ?? [])[0] as { webhooks_enabled: boolean } | undefined;

  return { enabled: row?.webhooks_enabled ?? true };
}

export async function setWebhookSettings(
  settings: WebhookSettings,
  db?: Db,
): Promise<WebhookSettings> {
  const handle: Db = db ?? getDb();

  await handle.execute(sql`
    UPDATE platform_runtime_settings
    SET webhooks_enabled = ${settings.enabled}, updated_at = now()
    WHERE id = 'singleton'
  `);

  return { enabled: settings.enabled };
}
