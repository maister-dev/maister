// T11 (ADR-077): platform admin webhook routes against a real testcontainer
// postgres. TDD RED — the route modules under `app/api/admin/webhooks/**` and
// `app/api/admin/webhook-settings` do not exist yet, so every dynamic
// `import("../route")` throws (missing module) until T11 lands. Docker-only
// (skipped where the daemon is absent), like the sibling *.integration.test.ts.
//
// Proves the platform-admin HTTP contract from docs/api/web.openapi.yaml:
//   - authz: 403 for member, 401 unauthenticated (every route),
//   - CRUD round-trip with NO secret value ever echoed (env: refs only),
//   - validation 422 CONFIG (raw secret value, non-http url, bogus event type),
//   - DELETE usage-guard (409 with delivery history / 204 without),
//   - replay 202|409|404 matrix (server-state ownership join),
//   - ping result shape (network stubbed), deliveries log + attempts[],
//   - webhook-settings GET/PATCH on the platform_runtime_settings singleton.
//
// Mirrors the auth/db mocking + dynamic-import harness of
// app/api/admin/mcp-servers/__tests__/admin-mcp-crud.integration.test.ts.
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { type NextRequest } from "next/server";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// ---------------------------------------------------------------------------
// Auth mock — controllable per test. Default = bootstrap admin. The authz
// scenarios flip the implementation to simulate a member (UNAUTHORIZED→403)
// and an unauthenticated caller (UNAUTHENTICATED→401), exactly as
// requireGlobalRole("admin") would throw via @/lib/errors.
// ---------------------------------------------------------------------------
const requireGlobalRoleMock = vi.fn();

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireGlobalRole: (min: string) => requireGlobalRoleMock(min),
}));

// Ping performs a live signed POST (lib/webhooks/send → fetch). The route
// delegates to pingSubscription; stub it so the route path is exercised with a
// deterministic result and the network is never touched (mirrors how the
// mcp-servers tests keep side-effects out of the route assertions).
const pingSubscriptionMock = vi.fn();

vi.mock("@/lib/webhooks/ping", () => ({
  pingSubscription: (...args: unknown[]) => pingSubscriptionMock(...args),
}));

function asAdmin(): void {
  requireGlobalRoleMock.mockImplementation(async () => ({
    id: "usr_bootstrap_admin",
    role: "admin",
    mustChangePassword: false,
  }));
}

function asMember(): void {
  requireGlobalRoleMock.mockImplementation(async () => {
    throw new MaisterError("UNAUTHORIZED", "admin role required");
  });
}

function asAnonymous(): void {
  requireGlobalRoleMock.mockImplementation(async () => {
    throw new MaisterError("UNAUTHENTICATED", "sign-in required");
  });
}

// ---------------------------------------------------------------------------
// Request builders. Bodies carry config only — never cross-resource ids; ping
// and replay take an empty body (no body-controlled ids — Security checklist).
// ---------------------------------------------------------------------------
function postRequest(body: unknown): NextRequest {
  return new Request("http://x/api/admin/webhooks", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function patchRequest(body: unknown): NextRequest {
  return new Request("http://x", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function getRequest(): NextRequest {
  return new Request("http://x", { method: "GET" }) as unknown as NextRequest;
}

function deleteRequest(): NextRequest {
  return new Request("http://x", {
    method: "DELETE",
  }) as unknown as NextRequest;
}

function emptyPostRequest(): NextRequest {
  return new Request("http://x", { method: "POST" }) as unknown as NextRequest;
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function deliveryParams(id: string, deliveryId: string) {
  return { params: Promise.resolve({ id, deliveryId }) };
}

// ---------------------------------------------------------------------------
// Seed helpers. A platform subscription has project_id = NULL. Delivery-history
// seeding mirrors lib/webhooks/__tests__/replay.integration.test.ts: a run +
// project for the event FK, then event → delivery → attempt rows.
// ---------------------------------------------------------------------------
const VALID_CREATE = () => ({
  name: "ops-notifier",
  url: "https://hooks.example.com/maister",
  method: "POST" as const,
  headers: { "X-Team": "env:WH_TEAM_HEADER" },
  event_types: ["run.review", "run.done"],
  signing_secret_ref: "env:WH_X",
  enabled: true,
});

interface SeededRun {
  projectId: string;
  runId: string;
}

async function seedRunForEvents(): Promise<SeededRun> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${projectId.slice(0, 8)}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "Test task",
    prompt: "do the thing",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    status: "Review",
  });
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt-${runId.slice(0, 8)}`,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { projectId, runId };
}

// Insert a platform subscription directly (project_id NULL) and return its id.
// Used where a test needs delivery history that the POST route cannot create.
async function seedPlatformSubscription(): Promise<string> {
  const subId = randomUUID();

  await db.insert(schema.webhookSubscriptions).values({
    id: subId,
    projectId: null,
    name: `sub-${subId.slice(0, 8)}`,
    url: "https://hooks.example.com/seeded",
    eventTypes: ["run.review"],
    signingSecretRef: "env:WH_SEEDED",
    enabled: true,
  });

  return subId;
}

async function seedEvent(run: SeededRun): Promise<string> {
  const eventId = randomUUID();

  await db.insert(schema.webhookEvents).values({
    id: eventId,
    projectId: run.projectId,
    runId: run.runId,
    type: "run.review",
    data: { runId: run.runId },
    occurredAt: new Date(),
  });

  return eventId;
}

async function seedDelivery(
  subId: string,
  eventId: string,
  status: "pending" | "delivered" | "dead",
): Promise<string> {
  const deliveryId = randomUUID();

  await db.insert(schema.webhookDeliveries).values({
    id: deliveryId,
    eventId,
    subscriptionId: subId,
    status,
    attemptCount: status === "pending" ? 0 : 1,
    nextAttemptAt: new Date(Date.now() - 1_000),
    leaseExpiresAt: null,
    idempotencyKey: `${subId}:${eventId}`,
    lastHttpStatus:
      status === "delivered" ? 200 : status === "dead" ? 500 : null,
    lastErrorKind: status === "dead" ? "http" : null,
    deliveredAt: status === "delivered" ? new Date() : null,
  });

  return deliveryId;
}

async function seedAttempt(
  deliveryId: string,
  attemptNo: number,
): Promise<void> {
  await db.insert(schema.webhookDeliveryAttempts).values({
    id: randomUUID(),
    deliveryId,
    attemptNo,
    requestedAt: new Date(),
    durationMs: 12,
    httpStatus: 200,
    responseSnippet: "ok",
  });
}

async function fetchDeliveryStatus(
  deliveryId: string,
): Promise<string | undefined> {
  const r = await db.execute(sql`
    SELECT status FROM webhook_deliveries WHERE id = ${deliveryId}
  `);

  return (r.rows[0] as { status: string } | undefined)?.status;
}

// The singleton has a NOT-NULL FK default_runner_id, so seed a runner first.
async function seedSettingsSingleton(enabled: boolean): Promise<void> {
  const runnerId = randomUUID();

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.execute(sql`
    INSERT INTO platform_runtime_settings (id, default_runner_id, webhooks_enabled)
    VALUES ('singleton', ${runnerId}, ${enabled})
    ON CONFLICT (id) DO UPDATE SET webhooks_enabled = ${enabled}
  `);
}

// A serialized subscription must never leak a resolved secret VALUE: assert the
// JSON blob contains the env: ref string but no plaintext-secret marker.
function expectNoSecretValue(serialized: string): void {
  expect(serialized).not.toContain("rawsecretvalue");
  expect(serialized).not.toContain("whsec_");
  expect(serialized).not.toContain("sk-");
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("webhook_admin_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  asAdmin();
  pingSubscriptionMock.mockReset();
});

// =============================================================================
// 1. Authz — every route is admin-gated. Non-admin → 403, anonymous → 401.
// =============================================================================
describe("admin webhook routes — authz", () => {
  it("returns 403 for a non-admin member on every route", async () => {
    asMember();

    const list = await import("../route");
    const byId = await import("../[id]/route");
    const deliveries = await import("../[id]/deliveries/route");
    const ping = await import("../[id]/ping/route");
    const replay = await import("../[id]/deliveries/[deliveryId]/replay/route");
    const settings = await import("../../webhook-settings/route");

    const id = randomUUID();
    const did = randomUUID();

    const results = await Promise.all([
      list.GET(getRequest()),
      list.POST(postRequest(VALID_CREATE())),
      byId.GET(getRequest(), idParams(id)),
      byId.PATCH(patchRequest({ enabled: false }), idParams(id)),
      byId.DELETE(deleteRequest(), idParams(id)),
      deliveries.GET(getRequest(), idParams(id)),
      ping.POST(emptyPostRequest(), idParams(id)),
      replay.POST(emptyPostRequest(), deliveryParams(id, did)),
      settings.GET(getRequest()),
      settings.PATCH(patchRequest({ enabled: false })),
    ]);

    for (const res of results) {
      expect(res.status).toBe(403);
    }
  });

  it("returns 401 for an unauthenticated caller on every route", async () => {
    asAnonymous();

    const list = await import("../route");
    const byId = await import("../[id]/route");
    const deliveries = await import("../[id]/deliveries/route");
    const ping = await import("../[id]/ping/route");
    const replay = await import("../[id]/deliveries/[deliveryId]/replay/route");
    const settings = await import("../../webhook-settings/route");

    const id = randomUUID();
    const did = randomUUID();

    const results = await Promise.all([
      list.GET(getRequest()),
      list.POST(postRequest(VALID_CREATE())),
      byId.GET(getRequest(), idParams(id)),
      byId.PATCH(patchRequest({ enabled: false }), idParams(id)),
      byId.DELETE(deleteRequest(), idParams(id)),
      deliveries.GET(getRequest(), idParams(id)),
      ping.POST(emptyPostRequest(), idParams(id)),
      replay.POST(emptyPostRequest(), deliveryParams(id, did)),
      settings.GET(getRequest()),
      settings.PATCH(patchRequest({ enabled: false })),
    ]);

    for (const res of results) {
      expect(res.status).toBe(401);
    }
  });
});

// =============================================================================
// 2. CRUD round-trip — create → list → get → patch, secrets never echoed.
// =============================================================================
describe("admin webhook CRUD round-trip", () => {
  it("creates a platform subscription, lists it, gets it, and patches it", async () => {
    const { GET, POST } = await import("../route");
    const byId = await import("../[id]/route");

    const created = await POST(postRequest(VALID_CREATE()));
    const createdBody = (await created.json()) as { ok: boolean; id: string };

    expect(created.status).toBe(201);
    expect(createdBody.ok).toBe(true);
    expect(typeof createdBody.id).toBe("string");

    const id = createdBody.id;

    // List includes it, scoped to project_id NULL, refs echoed, no value.
    const listRes = await GET(getRequest());
    const listText = await listRes.clone().text();
    const listBody = (await listRes.json()) as {
      subscriptions: Array<Record<string, unknown>>;
    };

    expect(listRes.status).toBe(200);

    const listed = listBody.subscriptions.find((s) => s.id === id);

    expect(listed).toBeDefined();
    expect(listed?.projectId).toBeNull();
    expect(listed?.signing_secret_ref).toBe("env:WH_X");
    expect(listed?.event_types).toEqual(["run.review", "run.done"]);
    expectNoSecretValue(listText);

    // Get by id returns the row.
    const getRes = await byId.GET(getRequest(), idParams(id));
    const getText = await getRes.clone().text();
    const gotBody = (await getRes.json()) as Record<string, unknown>;

    expect(getRes.status).toBe(200);
    expect(gotBody.id).toBe(id);
    expect(gotBody.projectId).toBeNull();
    expect(gotBody.signing_secret_ref).toBe("env:WH_X");
    expectNoSecretValue(getText);

    // Patch: disable + add an event type. Response never carries a secret value.
    const patchRes = await byId.PATCH(
      patchRequest({
        enabled: false,
        event_types: ["run.review", "run.done", "run.failed"],
      }),
      idParams(id),
    );

    expect(patchRes.status).toBe(200);

    const afterRes = await byId.GET(getRequest(), idParams(id));
    const afterText = await afterRes.clone().text();
    const after = (await afterRes.json()) as Record<string, unknown>;

    expect(after.enabled).toBe(false);
    expect(after.event_types).toEqual(["run.review", "run.done", "run.failed"]);
    expectNoSecretValue(afterText);
  });

  it("clears secondary_signing_secret_ref and headers on PATCH (CLEAR half persists)", async () => {
    const { POST } = await import("../route");
    const byId = await import("../[id]/route");

    const created = await POST(postRequest(VALID_CREATE()));
    const { id } = (await created.json()) as { id: string };

    // SET half: rotation overlap ref lands.
    const setRes = await byId.PATCH(
      patchRequest({ secondary_signing_secret_ref: "env:WH_X_NEXT" }),
      idParams(id),
    );

    expect(setRes.status).toBe(200);

    const afterSetRes = await byId.GET(getRequest(), idParams(id));
    const afterSet = (await afterSetRes.json()) as Record<string, unknown>;

    expect(afterSet.secondary_signing_secret_ref).toBe("env:WH_X_NEXT");

    // CLEAR half: dropping the old ref (rotation completion) and the extra
    // headers persists the cleared state — not the stale prior values.
    const clearRes = await byId.PATCH(
      patchRequest({ secondary_signing_secret_ref: null, headers: {} }),
      idParams(id),
    );

    expect(clearRes.status).toBe(200);

    const afterClearRes = await byId.GET(getRequest(), idParams(id));
    const afterClear = (await afterClearRes.json()) as Record<string, unknown>;

    expect(afterClear.secondary_signing_secret_ref).toBeNull();
    expect(afterClear.headers).toEqual({});
    // The primary ref is untouched by the clear.
    expect(afterClear.signing_secret_ref).toBe("env:WH_X");
  });

  it("returns 404 for GET/PATCH/DELETE of an unknown id", async () => {
    const byId = await import("../[id]/route");
    const unknown = randomUUID();

    const got = await byId.GET(getRequest(), idParams(unknown));

    expect(got.status).toBe(404);

    const patched = await byId.PATCH(
      patchRequest({ enabled: false }),
      idParams(unknown),
    );

    expect(patched.status).toBe(404);

    const deleted = await byId.DELETE(deleteRequest(), idParams(unknown));

    expect(deleted.status).toBe(404);
  });
});

// =============================================================================
// 3. Validation — env:NAME ref discipline, http(s) url, taxonomy event_types.
//    Per docs/api/web.openapi.yaml these are CONFIG → 422 (the catalog-error
//    mapping mirrored from POST /api/admin/mcp-servers).
// =============================================================================
describe("admin webhook validation", () => {
  it("rejects a raw secret value (env:NAME ref required) on POST with 422", async () => {
    const { POST } = await import("../route");

    const res = await POST(
      postRequest({ ...VALID_CREATE(), signing_secret_ref: "rawsecretvalue" }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects a non-http(s) url on POST with 422", async () => {
    const { POST } = await import("../route");

    const res = await POST(
      postRequest({ ...VALID_CREATE(), url: "ftp://x/y" }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects an unknown event_types entry on POST with 422", async () => {
    const { POST } = await import("../route");

    const res = await POST(
      postRequest({ ...VALID_CREATE(), event_types: ["bogus.type"] }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("accepts the wildcard event_types selector ['*']", async () => {
    const { POST } = await import("../route");

    const res = await POST(
      postRequest({ ...VALID_CREATE(), event_types: ["*"] }),
    );

    expect(res.status).toBe(201);
  });

  it("rejects a raw secret value on PATCH with 422", async () => {
    const { POST } = await import("../route");
    const byId = await import("../[id]/route");

    const created = await POST(postRequest(VALID_CREATE()));
    const { id } = (await created.json()) as { id: string };

    const res = await byId.PATCH(
      patchRequest({ signing_secret_ref: "rawsecretvalue" }),
      idParams(id),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects a literal header value (env:NAME ref required) on POST with 422", async () => {
    const { POST } = await import("../route");

    const res = await POST(
      postRequest({
        ...VALID_CREATE(),
        headers: { Authorization: "Bearer raw-token" },
      }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects a blocked (loopback/metadata) destination url on POST with 422", async () => {
    const { POST } = await import("../route");

    const res = await POST(
      postRequest({
        ...VALID_CREATE(),
        url: "http://169.254.169.254/latest/meta-data/",
      }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects a literal header value on PATCH with 422", async () => {
    const { POST } = await import("../route");
    const byId = await import("../[id]/route");

    const created = await POST(postRequest(VALID_CREATE()));
    const { id } = (await created.json()) as { id: string };

    const res = await byId.PATCH(
      patchRequest({ headers: { "X-Team": "platform" } }),
      idParams(id),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });
});

// =============================================================================
// 4. DELETE usage-guard — 409 with delivery history, 204 without.
// =============================================================================
describe("admin webhook DELETE usage-guard", () => {
  it("refuses delete with 409 CONFLICT while delivery history exists", async () => {
    const byId = await import("../[id]/route");

    const run = await seedRunForEvents();
    const subId = await seedPlatformSubscription();
    const eventId = await seedEvent(run);

    await seedDelivery(subId, eventId, "delivered");

    const res = await byId.DELETE(deleteRequest(), idParams(subId));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");

    // The row survives the blocked delete.
    const after = await db.execute(sql`
      SELECT id FROM webhook_subscriptions WHERE id = ${subId}
    `);

    expect(after.rows).toHaveLength(1);
  });

  it("hard-deletes a subscription with no delivery history", async () => {
    const { POST } = await import("../route");
    const byId = await import("../[id]/route");

    const created = await POST(postRequest(VALID_CREATE()));
    const { id } = (await created.json()) as { id: string };

    const res = await byId.DELETE(deleteRequest(), idParams(id));

    expect([200, 204]).toContain(res.status);

    const after = await db.execute(sql`
      SELECT id FROM webhook_subscriptions WHERE id = ${id}
    `);

    expect(after.rows).toHaveLength(0);
  });
});

// =============================================================================
// 5. Replay — 202 from a delivered row, 409 from a pending row, 404 when the
//    delivery does not belong to the path subscription (server-state join).
// =============================================================================
describe("admin webhook replay", () => {
  it("re-queues a delivered delivery (202) and resets it to pending", async () => {
    const replay = await import("../[id]/deliveries/[deliveryId]/replay/route");

    const run = await seedRunForEvents();
    const subId = await seedPlatformSubscription();
    const eventId = await seedEvent(run);
    const deliveryId = await seedDelivery(subId, eventId, "delivered");

    await seedAttempt(deliveryId, 1);

    const res = await replay.POST(
      emptyPostRequest(),
      deliveryParams(subId, deliveryId),
    );
    const body = (await res.json()) as { ok?: boolean };

    expect(res.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(await fetchDeliveryStatus(deliveryId)).toBe("pending");
  });

  it("refuses to replay a pending delivery with 409 CONFLICT", async () => {
    const replay = await import("../[id]/deliveries/[deliveryId]/replay/route");

    const run = await seedRunForEvents();
    const subId = await seedPlatformSubscription();
    const eventId = await seedEvent(run);
    const deliveryId = await seedDelivery(subId, eventId, "pending");

    const res = await replay.POST(
      emptyPostRequest(),
      deliveryParams(subId, deliveryId),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    // Still pending — replay did not mutate it.
    expect(await fetchDeliveryStatus(deliveryId)).toBe("pending");
  });

  it("returns 404 when the delivery belongs to a different subscription", async () => {
    const replay = await import("../[id]/deliveries/[deliveryId]/replay/route");

    const run = await seedRunForEvents();
    const ownerSub = await seedPlatformSubscription();
    const otherSub = await seedPlatformSubscription();
    const eventId = await seedEvent(run);
    // Delivery is owned by ownerSub; we replay it through otherSub's path.
    const deliveryId = await seedDelivery(ownerSub, eventId, "delivered");

    const res = await replay.POST(
      emptyPostRequest(),
      deliveryParams(otherSub, deliveryId),
    );

    expect(res.status).toBe(404);
    // The cross-subscription replay never touched the row.
    expect(await fetchDeliveryStatus(deliveryId)).toBe("delivered");
  });
});

// =============================================================================
// 6. Ping — the route calls pingSubscription (stubbed) and returns its
//    PingResult shape {ok, httpStatus, durationMs} with status 200.
// =============================================================================
describe("admin webhook ping", () => {
  it("returns the ping result shape from a successful ping", async () => {
    const ping = await import("../[id]/ping/route");

    const subId = await seedPlatformSubscription();

    pingSubscriptionMock.mockResolvedValue({
      ok: true,
      httpStatus: 200,
      durationMs: 118,
    });

    const res = await ping.POST(emptyPostRequest(), idParams(subId));
    const body = (await res.json()) as {
      ok: boolean;
      httpStatus?: number;
      durationMs: number;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.httpStatus).toBe(200);
    expect(typeof body.durationMs).toBe("number");
    expect(pingSubscriptionMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refused ping (non-2xx) as ok=false with the http status", async () => {
    const ping = await import("../[id]/ping/route");

    const subId = await seedPlatformSubscription();

    pingSubscriptionMock.mockResolvedValue({
      ok: false,
      httpStatus: 500,
      durationMs: 95,
      errorKind: "http",
    });

    const res = await ping.POST(emptyPostRequest(), idParams(subId));
    const body = (await res.json()) as {
      ok: boolean;
      httpStatus?: number;
      errorKind?: string;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.httpStatus).toBe(500);
    expect(body.errorKind).toBe("http");
  });

  it("returns 404 when pinging an unknown subscription", async () => {
    const ping = await import("../[id]/ping/route");

    const res = await ping.POST(emptyPostRequest(), idParams(randomUUID()));

    expect(res.status).toBe(404);
    // Unknown subscription must short-circuit before any ping send.
    expect(pingSubscriptionMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 7. Deliveries log — paged list, each item carries status/attemptCount/
//    lastHttpStatus + an attempts[] array; cross-subscription isolation.
// =============================================================================
describe("admin webhook deliveries log", () => {
  it("lists deliveries with their attempts[] audit trail", async () => {
    const deliveries = await import("../[id]/deliveries/route");

    const run = await seedRunForEvents();
    const subId = await seedPlatformSubscription();
    const eventId = await seedEvent(run);
    const deliveryId = await seedDelivery(subId, eventId, "delivered");

    await seedAttempt(deliveryId, 1);

    const res = await deliveries.GET(getRequest(), idParams(subId));
    const body = (await res.json()) as {
      deliveries: Array<{
        id: string;
        status: string;
        attemptCount: number;
        lastHttpStatus: number | null;
        attempts: Array<{ attemptNo: number }>;
      }>;
      nextCursor: string | null;
    };

    expect(res.status).toBe(200);
    expect(Array.isArray(body.deliveries)).toBe(true);
    expect(body).toHaveProperty("nextCursor");

    const row = body.deliveries.find((d) => d.id === deliveryId);

    expect(row).toBeDefined();
    expect(row?.status).toBe("delivered");
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastHttpStatus).toBe(200);
    expect(Array.isArray(row?.attempts)).toBe(true);
    expect(row?.attempts.some((a) => a.attemptNo === 1)).toBe(true);
  });

  it("isolates deliveries to the path subscription (no cross-sub leak)", async () => {
    const deliveries = await import("../[id]/deliveries/route");

    const run = await seedRunForEvents();
    const subA = await seedPlatformSubscription();
    const subB = await seedPlatformSubscription();
    const eventA = await seedEvent(run);
    const eventB = await seedEvent(run);
    const deliveryA = await seedDelivery(subA, eventA, "delivered");
    const deliveryB = await seedDelivery(subB, eventB, "delivered");

    const res = await deliveries.GET(getRequest(), idParams(subA));
    const body = (await res.json()) as {
      deliveries: Array<{ id: string }>;
    };

    const ids = body.deliveries.map((d) => d.id);

    expect(ids).toContain(deliveryA);
    expect(ids).not.toContain(deliveryB);
  });

  it("returns 404 for the deliveries log of an unknown subscription", async () => {
    const deliveries = await import("../[id]/deliveries/route");

    const res = await deliveries.GET(getRequest(), idParams(randomUUID()));

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// 8. Webhook settings — GET {enabled}; PATCH {enabled:false} persists on the
//    platform_runtime_settings singleton; non-admin → 403.
// =============================================================================
describe("admin webhook settings", () => {
  it("GET returns the kill-switch state {enabled}", async () => {
    const settings = await import("../../webhook-settings/route");

    await seedSettingsSingleton(true);

    const res = await settings.GET(getRequest());
    const body = (await res.json()) as { enabled: boolean };

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(true);
  });

  it("PATCH {enabled:false} persists on the singleton", async () => {
    const settings = await import("../../webhook-settings/route");

    await seedSettingsSingleton(true);

    const res = await settings.PATCH(patchRequest({ enabled: false }));
    const body = (await res.json()) as { enabled: boolean };

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);

    const row = await db.execute(sql`
      SELECT webhooks_enabled FROM platform_runtime_settings WHERE id = 'singleton'
    `);

    expect(
      (row.rows[0] as { webhooks_enabled: boolean }).webhooks_enabled,
    ).toBe(false);
  });

  it("PATCH with a non-boolean enabled is rejected 422", async () => {
    const settings = await import("../../webhook-settings/route");

    await seedSettingsSingleton(true);

    const res = await settings.PATCH(patchRequest({ enabled: "nope" }));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("settings routes are admin-gated (member → 403)", async () => {
    asMember();
    const settings = await import("../../webhook-settings/route");

    const got = await settings.GET(getRequest());
    const patched = await settings.PATCH(patchRequest({ enabled: false }));

    expect(got.status).toBe(403);
    expect(patched.status).toBe(403);
  });
});
