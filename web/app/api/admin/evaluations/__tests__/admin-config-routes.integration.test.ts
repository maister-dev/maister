import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let panelsRoute: typeof import("../judge-panels/route");
let panelRoute: typeof import("../judge-panels/[panelId]/route");
let profilesRoute: typeof import("../profiles/route");
let profileRoute: typeof import("../profiles/[profileId]/route");
let methodologiesRoute: typeof import("../methodologies/route");
let activationRoute: typeof import("../methodologies/[methodRevisionId]/activation/route");
let overrideRoute: typeof import("@/app/api/projects/[slug]/evaluation-profiles/[profileId]/override/route");

let adminId: string;
let memberId: string;
let projectId: string;
let slug: string;
let methodRevisionId: string;

function asAdmin(): void {
  sessionRef.value = { user: { id: adminId } };
}
function asMember(): void {
  sessionRef.value = { user: { id: memberId } };
}

function req(
  path: string,
  init?: { method?: string; body?: unknown; ifMatch?: string },
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (init?.ifMatch) headers["if-match"] = init.ifMatch;

  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const PANEL_BODY = {
  name: "Panel",
  roleBindings: [{ role: "reviewer", agentId: "core:sdd-judge" }],
  policy: {
    attempts: 2,
    maxParallelAttempts: 1,
    quorum: 2,
    timeoutMs: 60_000,
    maxRetries: 1,
    blindLabels: true,
    randomizeOrder: true,
    allowedMcps: [],
  },
};

// The DTO projection surface — exactly these keys, never server-only fields
// like createdByUserId/updatedByUserId.
const PANEL_DTO_KEYS = [
  "id",
  "name",
  "revision",
  "roleBindings",
  "policy",
  "enabled",
  "updatedAt",
].sort();
const PROFILE_DTO_KEYS = [
  "id",
  "name",
  "revision",
  "methodRevisionId",
  "panelId",
  "defaults",
  "hardLimits",
  "allowedOverrides",
  "enabled",
  "updatedAt",
].sort();

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "admin_eval_config_routes_test",
  });
  db = testDatabase.db;

  panelsRoute = await import("../judge-panels/route");
  panelRoute = await import("../judge-panels/[panelId]/route");
  profilesRoute = await import("../profiles/route");
  profileRoute = await import("../profiles/[profileId]/route");
  methodologiesRoute = await import("../methodologies/route");
  activationRoute = await import(
    "../methodologies/[methodRevisionId]/activation/route"
  );
  overrideRoute = await import(
    "@/app/api/projects/[slug]/evaluation-profiles/[profileId]/override/route"
  );

  adminId = randomUUID();
  memberId = randomUUID();
  await db.insert(schema.users).values([
    {
      id: adminId,
      email: `${adminId}@t.com`,
      role: "admin",
      accountStatus: "active",
      passwordHash: "x",
    },
    {
      id: memberId,
      email: `${memberId}@t.com`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    },
  ]);

  projectId = randomUUID();
  slug = `proj-${projectId.slice(0, 8)}`;
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  const installId = randomUUID();

  await db.insert(schema.packageInstalls).values({
    id: installId,
    sourceUrl: "github.com/x/core",
    name: "core",
    versionLabel: "v1.1.0",
    resolvedRevision: "deadbeef",
    manifest: { spec: { name: "core" } },
    manifestDigest: "d",
    installedPath: "/tmp/core",
    packageStatus: "Installed",
    trustStatus: "trusted",
  });

  methodRevisionId = randomUUID();
  await db.insert(schema.evaluationMethodRevisions).values({
    id: methodRevisionId,
    packageInstallId: installId,
    methodId: "sdd-quality",
    qualifiedId: "core:sdd-quality",
    packageName: "core",
    versionLabel: "v1.1.0",
    schemaVersion: 1,
    normalizedDefinition: {},
    definitionDigest: "dd",
    promptDigest: "pd",
    schemaDigest: "sd",
    compat: { engineMin: "3.2.0" },
    activation: "disabled",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(() => {
  sessionRef.value = null;
});

describe("admin evaluation config routes (HTTP layer)", () => {
  it("refuses every route unauthenticated (401) and for a non-admin (403)", async () => {
    const anyId = randomUUID();
    const calls: Array<[string, () => Promise<Response>]> = [
      ["panels GET", () => panelsRoute.GET()],
      [
        "panels POST",
        () =>
          panelsRoute.POST(
            req("/api/admin/evaluations/judge-panels", {
              method: "POST",
              body: PANEL_BODY,
            }),
          ),
      ],
      [
        "panel GET",
        () =>
          panelRoute.GET(req(`/api/admin/evaluations/judge-panels/${anyId}`), {
            params: Promise.resolve({ panelId: anyId }),
          }),
      ],
      [
        "panel PATCH",
        () =>
          panelRoute.PATCH(
            req(`/api/admin/evaluations/judge-panels/${anyId}`, {
              method: "PATCH",
              ifMatch: "1",
              body: { name: "x" },
            }),
            { params: Promise.resolve({ panelId: anyId }) },
          ),
      ],
      [
        "panel DELETE",
        () =>
          panelRoute.DELETE(
            req(`/api/admin/evaluations/judge-panels/${anyId}`, {
              method: "DELETE",
              ifMatch: "1",
            }),
            { params: Promise.resolve({ panelId: anyId }) },
          ),
      ],
      ["profiles GET", () => profilesRoute.GET()],
      [
        "profiles POST",
        () =>
          profilesRoute.POST(
            req("/api/admin/evaluations/profiles", {
              method: "POST",
              body: {
                name: "P",
                methodRevisionId: anyId,
                panelId: anyId,
              },
            }),
          ),
      ],
      [
        "profile GET",
        () =>
          profileRoute.GET(req(`/api/admin/evaluations/profiles/${anyId}`), {
            params: Promise.resolve({ profileId: anyId }),
          }),
      ],
      [
        "profile PATCH",
        () =>
          profileRoute.PATCH(
            req(`/api/admin/evaluations/profiles/${anyId}`, {
              method: "PATCH",
              ifMatch: "1",
              body: { name: "x" },
            }),
            { params: Promise.resolve({ profileId: anyId }) },
          ),
      ],
      [
        "profile DELETE",
        () =>
          profileRoute.DELETE(
            req(`/api/admin/evaluations/profiles/${anyId}`, {
              method: "DELETE",
              ifMatch: "1",
            }),
            { params: Promise.resolve({ profileId: anyId }) },
          ),
      ],
      ["methodologies GET", () => methodologiesRoute.GET()],
      [
        "activation PATCH",
        () =>
          activationRoute.PATCH(
            req(`/api/admin/evaluations/methodologies/${anyId}/activation`, {
              method: "PATCH",
              body: { activation: "disabled" },
            }),
            { params: Promise.resolve({ methodRevisionId: anyId }) },
          ),
      ],
    ];

    // Sequential on purpose: authz resolves the session via a dynamic
    // import("@/auth"), and concurrent first-hit dynamic imports can race past
    // the vi.mock registry into the real next-auth module.
    for (const [label, call] of calls) {
      sessionRef.value = null;
      const unauthenticated = await call();

      expect(unauthenticated.status, label).toBe(401);
      expect(
        ((await unauthenticated.json()) as { code: string }).code,
        label,
      ).toBe("UNAUTHENTICATED");

      asMember();
      const forbidden = await call();

      expect(forbidden.status, label).toBe(403);
      expect(((await forbidden.json()) as { code: string }).code, label).toBe(
        "UNAUTHORIZED",
      );
    }
  });

  it("panel create/patch/delete round-trip: DTO shape, If-Match required, stale PATCH and DELETE → 409", async () => {
    asAdmin();

    const created = await panelsRoute.POST(
      req("/api/admin/evaluations/judge-panels", {
        method: "POST",
        body: PANEL_BODY,
      }),
    );

    expect(created.status).toBe(201);
    const { panel } = (await created.json()) as {
      panel: Record<string, unknown>;
    };

    expect(Object.keys(panel).sort()).toEqual(PANEL_DTO_KEYS);
    expect(panel.revision).toBe(1);
    expect(panel.enabled).toBe(true);

    const panelId = panel.id as string;
    const params = { params: Promise.resolve({ panelId }) };

    // Missing If-Match → 422 CONFIG.
    const noIfMatch = await panelRoute.PATCH(
      req(`/api/admin/evaluations/judge-panels/${panelId}`, {
        method: "PATCH",
        body: { name: "Renamed" },
      }),
      params,
    );

    expect(noIfMatch.status).toBe(422);

    // Stale If-Match on PATCH → 409.
    const stalePatch = await panelRoute.PATCH(
      req(`/api/admin/evaluations/judge-panels/${panelId}`, {
        method: "PATCH",
        ifMatch: "99",
        body: { name: "Renamed" },
      }),
      params,
    );

    expect(stalePatch.status).toBe(409);

    // Fresh PATCH bumps the revision.
    const patched = await panelRoute.PATCH(
      req(`/api/admin/evaluations/judge-panels/${panelId}`, {
        method: "PATCH",
        ifMatch: "1",
        body: { name: "Renamed", enabled: false },
      }),
      params,
    );

    expect(patched.status).toBe(200);
    const patchedPanel = ((await patched.json()) as any).panel;

    expect(patchedPanel.revision).toBe(2);
    expect(patchedPanel.name).toBe("Renamed");
    expect(Object.keys(patchedPanel).sort()).toEqual(PANEL_DTO_KEYS);

    // Missing If-Match on DELETE → 422; stale If-Match on DELETE → 409. The
    // revision guard is atomic in the DELETE's WHERE — this contract holds
    // regardless of the guard's implementation shape.
    const deleteNoIfMatch = await panelRoute.DELETE(
      req(`/api/admin/evaluations/judge-panels/${panelId}`, {
        method: "DELETE",
      }),
      params,
    );

    expect(deleteNoIfMatch.status).toBe(422);

    const staleDelete = await panelRoute.DELETE(
      req(`/api/admin/evaluations/judge-panels/${panelId}`, {
        method: "DELETE",
        ifMatch: "1",
      }),
      params,
    );

    expect(staleDelete.status).toBe(409);
    expect(((await staleDelete.json()) as { code: string }).code).toBe(
      "CONFLICT",
    );

    // The stale DELETE deleted nothing.
    const stillThere = await panelRoute.GET(
      req(`/api/admin/evaluations/judge-panels/${panelId}`),
      params,
    );

    expect(stillThere.status).toBe(200);

    // Current-revision DELETE succeeds; the panel is gone (404-shaped GET).
    const deleted = await panelRoute.DELETE(
      req(`/api/admin/evaluations/judge-panels/${panelId}`, {
        method: "DELETE",
        ifMatch: "2",
      }),
      params,
    );

    expect(deleted.status).toBe(200);

    const gone = await panelRoute.GET(
      req(`/api/admin/evaluations/judge-panels/${panelId}`),
      params,
    );

    expect(gone.status).toBe(404);
  });

  it("profile create/patch/delete round-trip with the same If-Match contract; usage-guarded panel delete → 409", async () => {
    asAdmin();

    const panelRes = await panelsRoute.POST(
      req("/api/admin/evaluations/judge-panels", {
        method: "POST",
        body: { ...PANEL_BODY, name: "Profile Panel" },
      }),
    );
    const panelId = ((await panelRes.json()) as any).panel.id as string;

    const created = await profilesRoute.POST(
      req("/api/admin/evaluations/profiles", {
        method: "POST",
        body: {
          name: "Profile",
          methodRevisionId,
          panelId,
          allowedOverrides: { timeoutMs: { min: 1000, max: 600_000 } },
          hardLimits: {},
        },
      }),
    );

    expect(created.status).toBe(201);
    const { profile } = (await created.json()) as {
      profile: Record<string, unknown>;
    };

    expect(Object.keys(profile).sort()).toEqual(PROFILE_DTO_KEYS);
    expect(profile.revision).toBe(1);
    expect(profile.methodRevisionId).toBe(methodRevisionId);

    const profileId = profile.id as string;
    const params = { params: Promise.resolve({ profileId }) };

    // A panel referenced by a profile cannot be deleted (usage guard → 409).
    const panelDelete = await panelRoute.DELETE(
      req(`/api/admin/evaluations/judge-panels/${panelId}`, {
        method: "DELETE",
        ifMatch: "1",
      }),
      { params: Promise.resolve({ panelId }) },
    );

    expect(panelDelete.status).toBe(409);

    const stalePatch = await profileRoute.PATCH(
      req(`/api/admin/evaluations/profiles/${profileId}`, {
        method: "PATCH",
        ifMatch: "42",
        body: { name: "nope" },
      }),
      params,
    );

    expect(stalePatch.status).toBe(409);

    const patched = await profileRoute.PATCH(
      req(`/api/admin/evaluations/profiles/${profileId}`, {
        method: "PATCH",
        ifMatch: "1",
        body: { enabled: false },
      }),
      params,
    );

    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).profile.revision).toBe(2);

    const staleDelete = await profileRoute.DELETE(
      req(`/api/admin/evaluations/profiles/${profileId}`, {
        method: "DELETE",
        ifMatch: "1",
      }),
      params,
    );

    expect(staleDelete.status).toBe(409);

    const deleted = await profileRoute.DELETE(
      req(`/api/admin/evaluations/profiles/${profileId}`, {
        method: "DELETE",
        ifMatch: "2",
      }),
      params,
    );

    expect(deleted.status).toBe(200);

    const gone = await profileRoute.GET(
      req(`/api/admin/evaluations/profiles/${profileId}`),
      params,
    );

    expect(gone.status).toBe(404);
  });

  it("lists methodologies and gates activation on ready health", async () => {
    asAdmin();

    const listed = await methodologiesRoute.GET();

    expect(listed.status).toBe(200);
    const { methodologies } = (await listed.json()) as {
      methodologies: Array<Record<string, unknown>>;
    };
    const mine = methodologies.find((m) => m.id === methodRevisionId);

    expect(mine).toBeTruthy();
    expect(mine?.qualifiedId).toBe("core:sdd-quality");
    expect(mine?.health).toBe("ready");
    // Never exposes the installed path or prompt/schema bodies.
    expect(mine).not.toHaveProperty("installedPath");
    expect(mine).not.toHaveProperty("normalizedDefinition");

    const enabled = await activationRoute.PATCH(
      req(
        `/api/admin/evaluations/methodologies/${methodRevisionId}/activation`,
        {
          method: "PATCH",
          body: { activation: "enabled" },
        },
      ),
      { params: Promise.resolve({ methodRevisionId }) },
    );

    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      ok: true,
      activation: "enabled",
      health: "ready",
    });

    const [row] = await db
      .select({ activation: schema.evaluationMethodRevisions.activation })
      .from(schema.evaluationMethodRevisions)
      .where(eq(schema.evaluationMethodRevisions.id, methodRevisionId));

    expect(row.activation).toBe("enabled");

    // Unknown revision → 404-shaped PRECONDITION.
    const missing = await activationRoute.PATCH(
      req(`/api/admin/evaluations/methodologies/${randomUUID()}/activation`, {
        method: "PATCH",
        body: { activation: "disabled" },
      }),
      { params: Promise.resolve({ methodRevisionId: randomUUID() }) },
    );

    expect(missing.status).toBe(404);
  });

  it("project override PUT/GET/DELETE round-trip; 403 for a non-member; disallowed key → 422", async () => {
    asAdmin();

    const panelRes = await panelsRoute.POST(
      req("/api/admin/evaluations/judge-panels", {
        method: "POST",
        body: { ...PANEL_BODY, name: "Override Panel" },
      }),
    );
    const panelId = ((await panelRes.json()) as any).panel.id as string;
    const profileRes = await profilesRoute.POST(
      req("/api/admin/evaluations/profiles", {
        method: "POST",
        body: {
          name: "Override Profile",
          methodRevisionId,
          panelId,
          allowedOverrides: { timeoutMs: { min: 1000, max: 600_000 } },
          hardLimits: {},
        },
      }),
    );
    const profileId = ((await profileRes.json()) as any).profile.id as string;
    const params = { params: Promise.resolve({ slug, profileId }) };

    // A global member with no project membership cannot manage overrides.
    asMember();
    const forbidden = await overrideRoute.PUT(
      req(`/api/projects/${slug}/evaluation-profiles/${profileId}/override`, {
        method: "PUT",
        body: { overrides: { timeoutMs: 120_000 } },
      }),
      params,
    );

    expect(forbidden.status).toBe(403);

    asAdmin();

    // Inherit by default.
    const before = await overrideRoute.GET(
      req(`/api/projects/${slug}/evaluation-profiles/${profileId}/override`),
      params,
    );

    expect(before.status).toBe(200);
    expect(((await before.json()) as any).override).toBeNull();

    // A key outside the profile allow-list is refused (422 CONFIG).
    const disallowed = await overrideRoute.PUT(
      req(`/api/projects/${slug}/evaluation-profiles/${profileId}/override`, {
        method: "PUT",
        body: { overrides: { maxRetries: 5 } },
      }),
      params,
    );

    expect(disallowed.status).toBe(422);

    const put = await overrideRoute.PUT(
      req(`/api/projects/${slug}/evaluation-profiles/${profileId}/override`, {
        method: "PUT",
        body: { overrides: { timeoutMs: 120_000 } },
      }),
      params,
    );

    expect(put.status).toBe(200);
    const putBody = (await put.json()) as any;

    expect(putBody.override).toMatchObject({
      profileId,
      revision: 1,
      overrides: { timeoutMs: 120_000 },
    });

    const after = await overrideRoute.GET(
      req(`/api/projects/${slug}/evaluation-profiles/${profileId}/override`),
      params,
    );

    expect(((await after.json()) as any).override.overrides).toEqual({
      timeoutMs: 120_000,
    });

    const cleared = await overrideRoute.DELETE(
      req(`/api/projects/${slug}/evaluation-profiles/${profileId}/override`, {
        method: "DELETE",
      }),
      params,
    );

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ cleared: true });

    // Idempotent clear.
    const clearedAgain = await overrideRoute.DELETE(
      req(`/api/projects/${slug}/evaluation-profiles/${profileId}/override`, {
        method: "DELETE",
      }),
      params,
    );

    expect(await clearedAgain.json()).toEqual({ cleared: false });
  });
});
