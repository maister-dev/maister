// T12 (ADR-077): project-scope webhook routes against a real testcontainer
// postgres. TDD RED — the route modules under
// `app/api/projects/[slug]/webhooks/**` do not exist yet, so every dynamic
// `import("../route")` throws (missing module) until T12 lands. Docker-only
// (skipped where the daemon is absent), like the sibling *.integration.test.ts.
//
// These routes MIRROR the platform-admin webhook routes (T11,
// `app/api/admin/webhooks/**`) but under PROJECT scope. They behave identically
// EXCEPT for two things, and those two are the entire reason this file exists —
// the security-NEW surface:
//
//   1. AUTHZ — project-membership, NOT global admin. Per the user decision
//      (2026-06-10, plan "Resolved questions" #1) project webhook WRITE is
//      deliberately LOOSER than the MCP-catalog admin-write precedent:
//        - reads  (GET list/get/deliveries) → any project member, incl. VIEWER
//        - writes (POST/PATCH/DELETE/ping/replay) → member or above
//          (owner|admin|member); viewer is read-only → 403
//        - non-member → 403; unauthenticated → 401
//        - a global admin bypasses project-role checks (→ owner), per
//          requireProjectRole semantics (lib/authz.ts:194-222).
//      This is the `requireProjectRole`/`requireProjectAction` family with the
//      `member` threshold (PROJECT_ACTION_MIN.launchRun === "member" is the
//      shape; the implementor picks/adds the matching action), wired like
//      app/api/projects/[slug]/mcp/route.ts — but at the looser member tier,
//      NOT the mcp manageCatalog (admin) tier.
//
//   2. SCOPE — `projectId` is ALWAYS server-derived from the url `slug`
//      (404 if the project is missing/archived), never a body field. Every
//      read/write is scoped { projectId } so a subscription that belongs to a
//      DIFFERENT project — or to the PLATFORM (project_id NULL) — is invisible
//      and yields 404. A delivery that does not belong to the path
//      subscription-under-this-project is a 404 before replayDelivery runs.
//
// Auth harness mirrors app/api/projects/[slug]/mcp/__tests__/route.integration
// .test.ts: we mock `@/auth` so `auth()` returns a controllable session, seed
// real `users` + `project_members` rows with specific roles, and let the REAL
// `requireProjectRole` execute against postgres — so the viewer/member/owner/
// admin/non-member matrix is exercised through the actual authz code path, not
// a stub. The CRUD/validation/delete-guard/replay/deliveries/ping scenarios are
// the T11 ones, re-asserted under project scope + member authz.
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
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// ---------------------------------------------------------------------------
// Auth mock — controllable per test via `sessionRef`. We mock ONLY `@/auth`
// (the NextAuth `auth()` entrypoint) and let the real lib/authz.ts run against
// the seeded users + project_members rows. `auth()` supplies just the user id;
// requireProjectRole re-reads role/membership from the DB (DB-authoritative),
// so flipping `sessionRef.value` between the seeded ids drives the whole
// viewer/member/owner/admin/non-member/anonymous matrix through the genuine
// authorization path.
// ---------------------------------------------------------------------------
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// Ping performs a live signed POST (lib/webhooks/send → fetch). The route
// delegates to pingSubscription; stub it so the route path is exercised with a
// deterministic result and the network is never touched (mirrors T11).
const pingSubscriptionMock = vi.fn();

vi.mock("@/lib/webhooks/ping", () => ({
  pingSubscription: (...args: unknown[]) => pingSubscriptionMock(...args),
}));

// ---------------------------------------------------------------------------
// Seeded identities (global role on the left, project A membership on the
// right). u-b-member is a member of project B ONLY — i.e. a NON-member of A.
// ---------------------------------------------------------------------------
const ADMIN = { user: { id: "u-admin", role: "admin" } }; // global admin → owner
const OWNER = { user: { id: "u-owner", role: "member" } }; // project A owner
const PADMIN = { user: { id: "u-padmin", role: "member" } }; // project A admin
const MEMBER = { user: { id: "u-member", role: "member" } }; // project A member
const VIEWER = { user: { id: "u-viewer", role: "member" } }; // project A viewer
const OUTSIDER = { user: { id: "u-outside", role: "member" } }; // no membership
const B_MEMBER = { user: { id: "u-b-member", role: "member" } }; // member of B only

const PROJECT_A_ID = randomUUID();
const PROJECT_A_SLUG = `proj-wh-${randomUUID().slice(0, 8)}`;
const PROJECT_B_ID = randomUUID();
const PROJECT_B_SLUG = `proj-wh-other-${randomUUID().slice(0, 8)}`;
const UNKNOWN_SLUG = `proj-wh-missing-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Request builders. Bodies carry config only — never cross-resource ids; ping
// and replay take an empty body (no body-controlled ids — Security checklist
// "Identifier discipline"). The path `slug` is the ONLY project selector.
// ---------------------------------------------------------------------------
function postRequest(body: unknown): NextRequest {
  return new Request("http://x/api/projects/x/webhooks", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }) as unknown as NextRequest;
}

function patchRequest(body: unknown): NextRequest {
  return new Request("http://x", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
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

// Project-scoped route contexts. The collection routes get { slug }; the item
// routes get { slug, id }; replay gets { slug, id, deliveryId }.
function slugParams(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function idParams(slug: string, id: string) {
  return { params: Promise.resolve({ slug, id }) };
}

function deliveryParams(slug: string, id: string, deliveryId: string) {
  return { params: Promise.resolve({ slug, id, deliveryId }) };
}

// ---------------------------------------------------------------------------
// Create body. A project subscription is created with project_id = the
// resolved project's id (server-derived from slug), NOT from any body field —
// the body intentionally carries NO project_id.
// ---------------------------------------------------------------------------
const VALID_CREATE = () => ({
  name: "team-notifier",
  url: "https://hooks.example.com/maister",
  method: "POST" as const,
  headers: { "X-Team": "env:WH_TEAM_HEADER" },
  event_types: ["run.review", "run.done"],
  signing_secret_ref: "env:WH_PROJ",
  enabled: true,
});

// ---------------------------------------------------------------------------
// Seed helpers — a run+project for the event FK, then event → delivery →
// attempt rows. Mirrors the T11 admin test + lib/webhooks replay tests. The
// per-project event/delivery seeding is keyed to whichever project a
// subscription belongs to.
// ---------------------------------------------------------------------------
interface SeededRun {
  projectId: string;
  runId: string;
}

async function seedRunForEvents(projectId: string): Promise<SeededRun> {
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    // Per-call-unique ref: this helper is invoked repeatedly against the SAME
    // fixed project (PROJECT_A_ID), and flows_project_ref_uq is on
    // (project_id, flow_ref_id) — a constant ref would collide on the 2nd call.
    flowRefId: `bugfix-${flowId.slice(0, 8)}`,
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(crypto.randomUUID().slice(0, 6), 16),
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
    parentRepoPath: `/tmp/${projectId.slice(0, 8)}`,
  });

  return { projectId, runId };
}

// Insert a subscription scoped to a given project (or NULL for platform)
// directly, returning its id. Used where a test needs delivery history that
// the POST route cannot create, OR a foreign-scope row to prove isolation.
async function seedSubscription(projectId: string | null): Promise<string> {
  const subId = randomUUID();

  await db.insert(schema.webhookSubscriptions).values({
    id: subId,
    projectId,
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

async function subscriptionExists(subId: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT id FROM webhook_subscriptions WHERE id = ${subId}
  `);

  return (r.rows ?? []).length === 1;
}

// A serialized subscription must never leak a resolved secret VALUE: assert the
// JSON blob carries the env: ref string but no plaintext-secret marker.
function expectNoSecretValue(serialized: string): void {
  expect(serialized).not.toContain("rawsecretvalue");
  expect(serialized).not.toContain("whsec_");
  expect(serialized).not.toContain("sk-");
}

// Dynamic route imports — RED until the T12 modules land. Resolved lazily so a
// missing module is the FIRST failure these tests hit (proves the red is the
// absent route, not the harness).
const listMod = () => import("@/app/api/projects/[slug]/webhooks/route");
const itemMod = () => import("@/app/api/projects/[slug]/webhooks/[id]/route");
const deliveriesMod = () =>
  import("@/app/api/projects/[slug]/webhooks/[id]/deliveries/route");
const pingMod = () =>
  import("@/app/api/projects/[slug]/webhooks/[id]/ping/route");
const replayMod = () =>
  import(
    "@/app/api/projects/[slug]/webhooks/[id]/deliveries/[deliveryId]/replay/route"
  );

// Create a subscription through the real POST route as a writer (member) and
// return its id — used by scenarios that need a route-created project row.
async function createViaRoute(slug: string): Promise<string> {
  sessionRef.value = MEMBER;
  const { POST } = await listMod();
  const res = await POST(postRequest(VALID_CREATE()), slugParams(slug));
  const body = (await res.json()) as { ok: boolean; id: string };

  expect(res.status).toBe(201);

  return body.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("webhook_project_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  await db.insert(schema.projects).values([
    {
      taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: PROJECT_A_ID,
      slug: PROJECT_A_SLUG,
      name: PROJECT_A_SLUG,
      repoPath: `/tmp/${PROJECT_A_SLUG}`,
      maisterYamlPath: `/tmp/${PROJECT_A_SLUG}/maister.yaml`,
    },
    {
      taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: PROJECT_B_ID,
      slug: PROJECT_B_SLUG,
      name: PROJECT_B_SLUG,
      repoPath: `/tmp/${PROJECT_B_SLUG}`,
      maisterYamlPath: `/tmp/${PROJECT_B_SLUG}/maister.yaml`,
    },
  ]);

  await db.insert(schema.users).values([
    {
      id: "u-admin",
      email: "admin@test.com",
      role: "admin",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-owner",
      email: "owner@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-padmin",
      email: "padmin@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-member",
      email: "member@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-viewer",
      email: "viewer@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-outside",
      email: "outside@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-b-member",
      email: "bmember@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
  ]);

  await db.insert(schema.projectMembers).values([
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-owner",
      role: "owner",
    },
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-padmin",
      role: "admin",
    },
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-member",
      role: "member",
    },
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-viewer",
      role: "viewer",
    },
    // u-b-member belongs to project B only → a non-member of A.
    {
      id: randomUUID(),
      projectId: PROJECT_B_ID,
      userId: "u-b-member",
      role: "member",
    },
  ]);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  sessionRef.value = MEMBER;
  pingSubscriptionMock.mockReset();
});

// =============================================================================
// 1. AUTHZ MATRIX (security core). Reads allow any member incl. viewer; writes
//    require member+ (viewer → 403); non-member → 403; unauthenticated → 401.
//    The global admin bypasses project-role checks (→ owner) and may write.
// =============================================================================
describe("project webhook routes — authz matrix", () => {
  it("VIEWER may READ (GET list/get/deliveries → 2xx)", async () => {
    const { GET: LIST } = await listMod();
    const item = await itemMod();
    const deliveries = await deliveriesMod();

    // Seed a project-A subscription so get/deliveries have a real target.
    const subId = await seedSubscription(PROJECT_A_ID);

    sessionRef.value = VIEWER;

    const list = await LIST(getRequest(), slugParams(PROJECT_A_SLUG));
    const get = await item.GET(getRequest(), idParams(PROJECT_A_SLUG, subId));
    const log = await deliveries.GET(
      getRequest(),
      idParams(PROJECT_A_SLUG, subId),
    );

    expect(list.status).toBe(200);
    expect(get.status).toBe(200);
    expect(log.status).toBe(200);
  });

  it("VIEWER may NOT WRITE (POST/PATCH/DELETE/ping/replay → 403)", async () => {
    const list = await listMod();
    const item = await itemMod();
    const ping = await pingMod();
    const replay = await replayMod();

    const subId = await seedSubscription(PROJECT_A_ID);

    sessionRef.value = VIEWER;

    const id = subId;
    const did = randomUUID();

    const results = await Promise.all([
      list.POST(postRequest(VALID_CREATE()), slugParams(PROJECT_A_SLUG)),
      item.PATCH(
        patchRequest({ enabled: false }),
        idParams(PROJECT_A_SLUG, id),
      ),
      item.DELETE(deleteRequest(), idParams(PROJECT_A_SLUG, id)),
      ping.POST(emptyPostRequest(), idParams(PROJECT_A_SLUG, id)),
      replay.POST(emptyPostRequest(), deliveryParams(PROJECT_A_SLUG, id, did)),
    ]);

    for (const res of results) {
      expect(res.status).toBe(403);
    }
    // A denied write must not have invoked the ping send.
    expect(pingSubscriptionMock).not.toHaveBeenCalled();
  });

  it("MEMBER may READ and WRITE (2xx across the surface)", async () => {
    const list = await listMod();
    const item = await itemMod();

    sessionRef.value = MEMBER;

    // create (write)
    const created = await list.POST(
      postRequest(VALID_CREATE()),
      slugParams(PROJECT_A_SLUG),
    );
    const createdBody = (await created.json()) as { id: string };

    expect(created.status).toBe(201);

    const id = createdBody.id;

    // read
    const listed = await list.GET(getRequest(), slugParams(PROJECT_A_SLUG));
    const got = await item.GET(getRequest(), idParams(PROJECT_A_SLUG, id));

    expect(listed.status).toBe(200);
    expect(got.status).toBe(200);

    // write (patch + delete)
    const patched = await item.PATCH(
      patchRequest({ enabled: false }),
      idParams(PROJECT_A_SLUG, id),
    );

    expect(patched.status).toBe(200);

    const deleted = await item.DELETE(
      deleteRequest(),
      idParams(PROJECT_A_SLUG, id),
    );

    expect([200, 204]).toContain(deleted.status);
  });

  it("project OWNER and project ADMIN may WRITE (create → 201)", async () => {
    const list = await listMod();

    for (const session of [OWNER, PADMIN]) {
      sessionRef.value = session;

      const res = await list.POST(
        postRequest(VALID_CREATE()),
        slugParams(PROJECT_A_SLUG),
      );

      expect(res.status).toBe(201);
    }
  });

  it("global ADMIN bypasses project membership (→ owner) and may write", async () => {
    const list = await listMod();

    // u-admin has NO project_members row for A; the global-admin bypass in
    // requireProjectRole grants owner.
    sessionRef.value = ADMIN;

    const created = await list.POST(
      postRequest(VALID_CREATE()),
      slugParams(PROJECT_A_SLUG),
    );

    expect(created.status).toBe(201);

    const listed = await list.GET(getRequest(), slugParams(PROJECT_A_SLUG));

    expect(listed.status).toBe(200);
  });

  it("NON-MEMBER is denied on every route (403) — read AND write", async () => {
    const list = await listMod();
    const item = await itemMod();
    const deliveries = await deliveriesMod();
    const ping = await pingMod();
    const replay = await replayMod();

    const subId = await seedSubscription(PROJECT_A_ID);

    // u-b-member is a member of project B but NOT of project A.
    sessionRef.value = B_MEMBER;

    const id = subId;
    const did = randomUUID();

    const results = await Promise.all([
      list.GET(getRequest(), slugParams(PROJECT_A_SLUG)),
      list.POST(postRequest(VALID_CREATE()), slugParams(PROJECT_A_SLUG)),
      item.GET(getRequest(), idParams(PROJECT_A_SLUG, id)),
      item.PATCH(
        patchRequest({ enabled: false }),
        idParams(PROJECT_A_SLUG, id),
      ),
      item.DELETE(deleteRequest(), idParams(PROJECT_A_SLUG, id)),
      deliveries.GET(getRequest(), idParams(PROJECT_A_SLUG, id)),
      ping.POST(emptyPostRequest(), idParams(PROJECT_A_SLUG, id)),
      replay.POST(emptyPostRequest(), deliveryParams(PROJECT_A_SLUG, id, did)),
    ]);

    for (const res of results) {
      expect(res.status).toBe(403);
    }
  });

  it("a user with NO membership anywhere is denied (403) on read", async () => {
    const list = await listMod();

    sessionRef.value = OUTSIDER;

    const res = await list.GET(getRequest(), slugParams(PROJECT_A_SLUG));

    expect(res.status).toBe(403);
  });

  it("UNAUTHENTICATED is rejected on every route (401)", async () => {
    const list = await listMod();
    const item = await itemMod();
    const deliveries = await deliveriesMod();
    const ping = await pingMod();
    const replay = await replayMod();

    sessionRef.value = null;

    const id = randomUUID();
    const did = randomUUID();

    const results = await Promise.all([
      list.GET(getRequest(), slugParams(PROJECT_A_SLUG)),
      list.POST(postRequest(VALID_CREATE()), slugParams(PROJECT_A_SLUG)),
      item.GET(getRequest(), idParams(PROJECT_A_SLUG, id)),
      item.PATCH(
        patchRequest({ enabled: false }),
        idParams(PROJECT_A_SLUG, id),
      ),
      item.DELETE(deleteRequest(), idParams(PROJECT_A_SLUG, id)),
      deliveries.GET(getRequest(), idParams(PROJECT_A_SLUG, id)),
      ping.POST(emptyPostRequest(), idParams(PROJECT_A_SLUG, id)),
      replay.POST(emptyPostRequest(), deliveryParams(PROJECT_A_SLUG, id, did)),
    ]);

    for (const res of results) {
      expect(res.status).toBe(401);
    }
  });
});

// =============================================================================
// 2. CROSS-PROJECT + PLATFORM ISOLATION (security core). A subscription under
//    project A is invisible/uneditable via project B's slug (404). A PLATFORM
//    subscription (project_id NULL) is invisible via ANY project slug (404). A
//    delivery under A's sub, replayed via B, is a 404 before replayDelivery.
// =============================================================================
describe("project webhook routes — cross-project & platform isolation", () => {
  it("A's subscription is NOT in B's list and 404s on B's item/deliveries/ping/patch/delete", async () => {
    const list = await listMod();
    const item = await itemMod();
    const deliveries = await deliveriesMod();
    const ping = await pingMod();

    // Create a real subscription in project A (as A's member).
    const aSub = await createViaRoute(PROJECT_A_SLUG);

    // List under project B (as B's member) must NOT include A's subscription.
    sessionRef.value = B_MEMBER;

    const bList = await list.GET(getRequest(), slugParams(PROJECT_B_SLUG));
    const bListBody = (await bList.json()) as {
      subscriptions: Array<{ id: string }>;
    };

    expect(bList.status).toBe(200);
    expect(bListBody.subscriptions.map((s) => s.id)).not.toContain(aSub);

    // Every item/sub-collection route for A's id, addressed under B's slug, is 404.
    const got = await item.GET(getRequest(), idParams(PROJECT_B_SLUG, aSub));
    const patched = await item.PATCH(
      patchRequest({ enabled: false }),
      idParams(PROJECT_B_SLUG, aSub),
    );
    const deleted = await item.DELETE(
      deleteRequest(),
      idParams(PROJECT_B_SLUG, aSub),
    );
    const log = await deliveries.GET(
      getRequest(),
      idParams(PROJECT_B_SLUG, aSub),
    );

    pingSubscriptionMock.mockResolvedValue({
      ok: true,
      httpStatus: 200,
      durationMs: 1,
    });
    const pinged = await ping.POST(
      emptyPostRequest(),
      idParams(PROJECT_B_SLUG, aSub),
    );

    expect(got.status).toBe(404);
    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(log.status).toBe(404);
    expect(pinged.status).toBe(404);
    // The cross-project PATCH/DELETE never touched A's row, and ping never fired.
    expect(await subscriptionExists(aSub)).toBe(true);
    expect(pingSubscriptionMock).not.toHaveBeenCalled();

    // Under A's own slug (as A's member) the row is intact and visible.
    sessionRef.value = MEMBER;
    const ownGet = await item.GET(getRequest(), idParams(PROJECT_A_SLUG, aSub));

    expect(ownGet.status).toBe(200);
  });

  it("a PLATFORM subscription (project_id NULL) is invisible via ANY project slug (404)", async () => {
    const list = await listMod();
    const item = await itemMod();
    const deliveries = await deliveriesMod();

    const platformSub = await seedSubscription(null);

    sessionRef.value = MEMBER;

    // Not in project A's list.
    const aList = await list.GET(getRequest(), slugParams(PROJECT_A_SLUG));
    const aListBody = (await aList.json()) as {
      subscriptions: Array<{ id: string }>;
    };

    expect(aListBody.subscriptions.map((s) => s.id)).not.toContain(platformSub);

    // GET / PATCH / DELETE / deliveries of the platform id under A's slug → 404.
    const got = await item.GET(
      getRequest(),
      idParams(PROJECT_A_SLUG, platformSub),
    );
    const patched = await item.PATCH(
      patchRequest({ enabled: false }),
      idParams(PROJECT_A_SLUG, platformSub),
    );
    const deleted = await item.DELETE(
      deleteRequest(),
      idParams(PROJECT_A_SLUG, platformSub),
    );
    const log = await deliveries.GET(
      getRequest(),
      idParams(PROJECT_A_SLUG, platformSub),
    );

    expect(got.status).toBe(404);
    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(log.status).toBe(404);
    // The platform row survives the project-scoped delete attempt.
    expect(await subscriptionExists(platformSub)).toBe(true);
  });

  it("a delivery under A's sub, replayed via B's slug, is 404 before replayDelivery runs", async () => {
    const replay = await replayMod();

    // Subscription + delivered delivery under project A.
    const aSub = await seedSubscription(PROJECT_A_ID);
    const run = await seedRunForEvents(PROJECT_A_ID);
    const eventId = await seedEvent(run);
    const deliveryId = await seedDelivery(aSub, eventId, "delivered");

    await seedAttempt(deliveryId, 1);

    // Replay A's delivery addressed under project B's slug (as B's member).
    sessionRef.value = B_MEMBER;

    const res = await replay.POST(
      emptyPostRequest(),
      deliveryParams(PROJECT_B_SLUG, aSub, deliveryId),
    );

    expect(res.status).toBe(404);
    // The cross-scope replay never mutated the row (still delivered, not pending).
    expect(await fetchDeliveryStatus(deliveryId)).toBe("delivered");
  });
});

// =============================================================================
// 3. PROJECT CRUD ROUND-TRIP (as member) — project_id is the resolved project's
//    id (server-derived, never from body); list shows ONLY this project's subs;
//    validation 422s. Mirrors the T11 admin CRUD under project scope.
// =============================================================================
describe("project webhook CRUD round-trip (as member)", () => {
  it("creates with project_id = resolved project (not from body), lists only this project's subs, gets, patches", async () => {
    sessionRef.value = MEMBER;
    const list = await listMod();
    const item = await itemMod();

    // Seed a platform sub + a project-B sub to prove the list excludes them.
    const platformSub = await seedSubscription(null);
    const bSub = await seedSubscription(PROJECT_B_ID);

    // Create with a clean body; the row is scoped to the slug-resolved project,
    // never to a body field (a smuggled project_id is REJECTED, not ignored —
    // proven in the dedicated slug-resolution case below).
    const created = await list.POST(
      postRequest(VALID_CREATE()),
      slugParams(PROJECT_A_SLUG),
    );
    const createdBody = (await created.json()) as { ok: boolean; id: string };

    expect(created.status).toBe(201);
    expect(createdBody.ok).toBe(true);

    const id = createdBody.id;

    // List for project A: includes the new row, scoped to project A, with the
    // env: ref echoed and NO secret value — and excludes platform + B rows.
    const listRes = await list.GET(getRequest(), slugParams(PROJECT_A_SLUG));
    const listText = await listRes.clone().text();
    const listBody = (await listRes.json()) as {
      subscriptions: Array<Record<string, unknown>>;
    };

    expect(listRes.status).toBe(200);

    const ids = listBody.subscriptions.map((s) => s.id);

    expect(ids).toContain(id);
    expect(ids).not.toContain(platformSub);
    expect(ids).not.toContain(bSub);

    const listed = listBody.subscriptions.find((s) => s.id === id);

    expect(listed?.projectId).toBe(PROJECT_A_ID);
    expect(listed?.signing_secret_ref).toBe("env:WH_PROJ");
    expect(listed?.event_types).toEqual(["run.review", "run.done"]);
    expectNoSecretValue(listText);

    // GET by id is scoped to project A and carries project_id = A's id.
    const getRes = await item.GET(getRequest(), idParams(PROJECT_A_SLUG, id));
    const getText = await getRes.clone().text();
    const gotBody = (await getRes.json()) as Record<string, unknown>;

    expect(getRes.status).toBe(200);
    expect(gotBody.id).toBe(id);
    expect(gotBody.projectId).toBe(PROJECT_A_ID);
    expectNoSecretValue(getText);

    // PATCH disable + extend event types; response carries no secret value.
    const patchRes = await item.PATCH(
      patchRequest({
        enabled: false,
        event_types: ["run.review", "run.done", "run.failed"],
      }),
      idParams(PROJECT_A_SLUG, id),
    );

    expect(patchRes.status).toBe(200);

    const afterRes = await item.GET(getRequest(), idParams(PROJECT_A_SLUG, id));
    const afterText = await afterRes.clone().text();
    const after = (await afterRes.json()) as Record<string, unknown>;

    expect(after.enabled).toBe(false);
    expect(after.event_types).toEqual(["run.review", "run.done", "run.failed"]);
    expectNoSecretValue(afterText);
  });

  it("returns 404 for GET/PATCH/DELETE of an id unknown to this project", async () => {
    sessionRef.value = MEMBER;
    const item = await itemMod();
    const unknown = randomUUID();

    const got = await item.GET(getRequest(), idParams(PROJECT_A_SLUG, unknown));
    const patched = await item.PATCH(
      patchRequest({ enabled: false }),
      idParams(PROJECT_A_SLUG, unknown),
    );
    const deleted = await item.DELETE(
      deleteRequest(),
      idParams(PROJECT_A_SLUG, unknown),
    );

    expect(got.status).toBe(404);
    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
  });

  it("rejects a raw secret value (env:NAME ref required) on POST with 422", async () => {
    sessionRef.value = MEMBER;
    const { POST } = await listMod();

    const res = await POST(
      postRequest({ ...VALID_CREATE(), signing_secret_ref: "rawsecretvalue" }),
      slugParams(PROJECT_A_SLUG),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects a non-http(s) url on POST with 422", async () => {
    sessionRef.value = MEMBER;
    const { POST } = await listMod();

    const res = await POST(
      postRequest({ ...VALID_CREATE(), url: "ftp://x/y" }),
      slugParams(PROJECT_A_SLUG),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects an unknown event_types entry on POST with 422", async () => {
    sessionRef.value = MEMBER;
    const { POST } = await listMod();

    const res = await POST(
      postRequest({ ...VALID_CREATE(), event_types: ["bogus.type"] }),
      slugParams(PROJECT_A_SLUG),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects a raw secret value on PATCH with 422", async () => {
    sessionRef.value = MEMBER;
    const { POST } = await listMod();
    const item = await itemMod();

    const created = await POST(
      postRequest(VALID_CREATE()),
      slugParams(PROJECT_A_SLUG),
    );
    const { id } = (await created.json()) as { id: string };

    const res = await item.PATCH(
      patchRequest({ signing_secret_ref: "rawsecretvalue" }),
      idParams(PROJECT_A_SLUG, id),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("rejects a literal header value (env:NAME ref required) on POST with 422", async () => {
    sessionRef.value = MEMBER;
    const { POST } = await listMod();

    const res = await POST(
      postRequest({
        ...VALID_CREATE(),
        headers: { Authorization: "Bearer raw-token" },
      }),
      slugParams(PROJECT_A_SLUG),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });
});

// =============================================================================
// 4. DELETE usage-guard — 409 with delivery history, 204 without. Same as T11
//    but under project scope + member authz.
// =============================================================================
describe("project webhook DELETE usage-guard (as member)", () => {
  it("refuses delete with 409 CONFLICT while delivery history exists", async () => {
    sessionRef.value = MEMBER;
    const item = await itemMod();

    const subId = await seedSubscription(PROJECT_A_ID);
    const run = await seedRunForEvents(PROJECT_A_ID);
    const eventId = await seedEvent(run);

    await seedDelivery(subId, eventId, "delivered");

    const res = await item.DELETE(
      deleteRequest(),
      idParams(PROJECT_A_SLUG, subId),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(await subscriptionExists(subId)).toBe(true);
  });

  it("hard-deletes a subscription with no delivery history", async () => {
    const id = await createViaRoute(PROJECT_A_SLUG);
    const item = await itemMod();

    sessionRef.value = MEMBER;
    const res = await item.DELETE(
      deleteRequest(),
      idParams(PROJECT_A_SLUG, id),
    );

    expect([200, 204]).toContain(res.status);
    expect(await subscriptionExists(id)).toBe(false);
  });
});

// =============================================================================
// 5. REPLAY — 202 from delivered, 409 from pending, 404 for a foreign-sub
//    delivery — under project scope + member authz.
// =============================================================================
describe("project webhook replay (as member)", () => {
  it("re-queues a delivered delivery (202) and resets it to pending", async () => {
    sessionRef.value = MEMBER;
    const replay = await replayMod();

    const subId = await seedSubscription(PROJECT_A_ID);
    const run = await seedRunForEvents(PROJECT_A_ID);
    const eventId = await seedEvent(run);
    const deliveryId = await seedDelivery(subId, eventId, "delivered");

    await seedAttempt(deliveryId, 1);

    const res = await replay.POST(
      emptyPostRequest(),
      deliveryParams(PROJECT_A_SLUG, subId, deliveryId),
    );
    const body = (await res.json()) as { ok?: boolean };

    expect(res.status).toBe(202);
    expect(body.ok).toBe(true);
    expect(await fetchDeliveryStatus(deliveryId)).toBe("pending");
  });

  it("refuses to replay a pending delivery with 409 CONFLICT", async () => {
    sessionRef.value = MEMBER;
    const replay = await replayMod();

    const subId = await seedSubscription(PROJECT_A_ID);
    const run = await seedRunForEvents(PROJECT_A_ID);
    const eventId = await seedEvent(run);
    const deliveryId = await seedDelivery(subId, eventId, "pending");

    const res = await replay.POST(
      emptyPostRequest(),
      deliveryParams(PROJECT_A_SLUG, subId, deliveryId),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(await fetchDeliveryStatus(deliveryId)).toBe("pending");
  });

  it("returns 404 when the delivery belongs to a different subscription (same project)", async () => {
    sessionRef.value = MEMBER;
    const replay = await replayMod();

    const ownerSub = await seedSubscription(PROJECT_A_ID);
    const otherSub = await seedSubscription(PROJECT_A_ID);
    const run = await seedRunForEvents(PROJECT_A_ID);
    const eventId = await seedEvent(run);
    const deliveryId = await seedDelivery(ownerSub, eventId, "delivered");

    const res = await replay.POST(
      emptyPostRequest(),
      deliveryParams(PROJECT_A_SLUG, otherSub, deliveryId),
    );

    expect(res.status).toBe(404);
    expect(await fetchDeliveryStatus(deliveryId)).toBe("delivered");
  });
});

// =============================================================================
// 6. PING — route calls pingSubscription (stubbed) and returns its PingResult
//    shape; unknown sub → 404 before any send — under project scope + member.
// =============================================================================
describe("project webhook ping (as member)", () => {
  it("returns the ping result shape from a successful ping", async () => {
    sessionRef.value = MEMBER;
    const ping = await pingMod();

    const subId = await seedSubscription(PROJECT_A_ID);

    pingSubscriptionMock.mockResolvedValue({
      ok: true,
      httpStatus: 200,
      durationMs: 118,
    });

    const res = await ping.POST(
      emptyPostRequest(),
      idParams(PROJECT_A_SLUG, subId),
    );
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
    sessionRef.value = MEMBER;
    const ping = await pingMod();

    const subId = await seedSubscription(PROJECT_A_ID);

    pingSubscriptionMock.mockResolvedValue({
      ok: false,
      httpStatus: 500,
      durationMs: 95,
      errorKind: "http",
    });

    const res = await ping.POST(
      emptyPostRequest(),
      idParams(PROJECT_A_SLUG, subId),
    );
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

  it("returns 404 when pinging an unknown subscription (no send)", async () => {
    sessionRef.value = MEMBER;
    const ping = await pingMod();

    const res = await ping.POST(
      emptyPostRequest(),
      idParams(PROJECT_A_SLUG, randomUUID()),
    );

    expect(res.status).toBe(404);
    expect(pingSubscriptionMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 7. DELIVERIES LOG — paged list, each item carries status/attemptCount/
//    lastHttpStatus + an attempts[] array; per-subscription isolation — under
//    project scope + member.
// =============================================================================
describe("project webhook deliveries log (as member)", () => {
  it("lists deliveries with their attempts[] audit trail", async () => {
    sessionRef.value = MEMBER;
    const deliveries = await deliveriesMod();

    const subId = await seedSubscription(PROJECT_A_ID);
    const run = await seedRunForEvents(PROJECT_A_ID);
    const eventId = await seedEvent(run);
    const deliveryId = await seedDelivery(subId, eventId, "delivered");

    await seedAttempt(deliveryId, 1);

    const res = await deliveries.GET(
      getRequest(),
      idParams(PROJECT_A_SLUG, subId),
    );
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
    sessionRef.value = MEMBER;
    const deliveries = await deliveriesMod();

    const subA = await seedSubscription(PROJECT_A_ID);
    const subB = await seedSubscription(PROJECT_A_ID);
    const run = await seedRunForEvents(PROJECT_A_ID);
    const eventA = await seedEvent(run);
    const eventB = await seedEvent(run);
    const deliveryA = await seedDelivery(subA, eventA, "delivered");
    const deliveryB = await seedDelivery(subB, eventB, "delivered");

    const res = await deliveries.GET(
      getRequest(),
      idParams(PROJECT_A_SLUG, subA),
    );
    const body = (await res.json()) as { deliveries: Array<{ id: string }> };
    const ids = body.deliveries.map((d) => d.id);

    expect(ids).toContain(deliveryA);
    expect(ids).not.toContain(deliveryB);
  });

  it("returns 404 for the deliveries log of an unknown subscription", async () => {
    sessionRef.value = MEMBER;
    const deliveries = await deliveriesMod();

    const res = await deliveries.GET(
      getRequest(),
      idParams(PROJECT_A_SLUG, randomUUID()),
    );

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// 8. SLUG RESOLUTION — unknown slug → 404 on every route; projectId is never a
//    body field (a body project_id pointing at B does not retarget the create).
// =============================================================================
describe("project webhook routes — slug resolution", () => {
  it("returns 404 for an unknown project slug on every route", async () => {
    const list = await listMod();
    const item = await itemMod();
    const deliveries = await deliveriesMod();
    const ping = await pingMod();
    const replay = await replayMod();

    sessionRef.value = ADMIN; // even a global admin gets 404 — the project is gone.

    const id = randomUUID();
    const did = randomUUID();

    const results = await Promise.all([
      list.GET(getRequest(), slugParams(UNKNOWN_SLUG)),
      list.POST(postRequest(VALID_CREATE()), slugParams(UNKNOWN_SLUG)),
      item.GET(getRequest(), idParams(UNKNOWN_SLUG, id)),
      item.PATCH(patchRequest({ enabled: false }), idParams(UNKNOWN_SLUG, id)),
      item.DELETE(deleteRequest(), idParams(UNKNOWN_SLUG, id)),
      deliveries.GET(getRequest(), idParams(UNKNOWN_SLUG, id)),
      ping.POST(emptyPostRequest(), idParams(UNKNOWN_SLUG, id)),
      replay.POST(emptyPostRequest(), deliveryParams(UNKNOWN_SLUG, id, did)),
    ]);

    for (const res of results) {
      expect(res.status).toBe(404);
    }
  });

  it("REJECTS a body that smuggles a project_id (422), then creates scoped to the slug", async () => {
    sessionRef.value = MEMBER;
    const list = await listMod();

    // Row counts under BOTH the A slug's project and the smuggled B project are
    // snapshotted so the assertion proves THIS rejected POST persisted nothing,
    // independent of any rows other tests seeded earlier in the shared DB.
    const countFor = async (projectId: string): Promise<number> => {
      const r = await db.execute(sql`
        SELECT count(*)::int AS n FROM webhook_subscriptions
        WHERE project_id = ${projectId}
      `);

      return (r.rows[0] as { n: number }).n;
    };
    const aBefore = await countFor(PROJECT_A_ID);
    const bBefore = await countFor(PROJECT_B_ID);

    // A body that carries project_id at all is REJECTED (additionalProperties
    // false → 422 CONFIG): the body cannot smuggle a cross-resource id, so the
    // slug stays the sole project selector. Strict-reject is stronger than
    // silent-strip — a confused/hostile client cannot even probe with it.
    const rejected = await list.POST(
      postRequest({ ...VALID_CREATE(), project_id: PROJECT_B_ID }),
      slugParams(PROJECT_A_SLUG),
    );
    const rejectedBody = (await rejected.json()) as { code?: string };

    expect(rejected.status).toBe(422);
    expect(rejectedBody.code).toBe("CONFIG");

    // The rejected POST created NOTHING — neither under the slug-resolved
    // project A NOR under the smuggled project B.
    expect(await countFor(PROJECT_A_ID)).toBe(aBefore);
    expect(await countFor(PROJECT_B_ID)).toBe(bBefore);

    // The legit clean-body create under the A slug writes project_id = A's id,
    // derived from the path, never from the body.
    const created = await list.POST(
      postRequest(VALID_CREATE()),
      slugParams(PROJECT_A_SLUG),
    );
    const body = (await created.json()) as { id: string };

    expect(created.status).toBe(201);

    const row = await db.execute(sql`
      SELECT project_id FROM webhook_subscriptions WHERE id = ${body.id}
    `);

    expect((row.rows[0] as { project_id: string }).project_id).toBe(
      PROJECT_A_ID,
    );
  });
});
