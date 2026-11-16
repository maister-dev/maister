// ADR-206 wire contract: task_create.source, by-source lookup, bind, and the
// session-only detach. Domain semantics are owned by
// lib/tasks/external-source/__tests__/service.integration.test.ts; this file
// owns HTTP status/body shape and authorization (S5, S8, A1).

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { issueToken } from "@/lib/tokens/issue";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

type Routes = {
  create: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/route").POST;
  bySource: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/by-source/route").GET;
  bind: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/source/route").PUT;
  detach: typeof import("@/app/api/projects/[slug]/tasks/[number]/source/route").DELETE;
};
let routes: Routes;

const SOURCE = {
  kind: "github",
  instance: "github.com",
  scope: "acme/widgets",
  externalId: "I_wire_1",
  externalKey: "#7",
  url: "https://github.com/acme/widgets/issues/7",
};

const fx = {
  slug: "",
  projectId: "",
  otherSlug: "",
  memberId: "",
  viewerId: "",
  token: "",
  readOnlyToken: "",
  otherProjectToken: "",
};

async function seedProject(slug: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.projects).values({
    id,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    taskKey: `W${id.slice(0, 6).replace(/[^a-z0-9]/gi, "")}`.toUpperCase(),
  });

  return id;
}

function ext(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createWithSource(
  source: unknown,
  token = fx.token,
  slug = fx.slug,
) {
  const res = await routes.create(
    ext("POST", `/api/v1/ext/projects/${slug}/tasks`, token, {
      title: "Imported",
      prompt: "p",
      source,
    }),
    { params: Promise.resolve({ slug }) },
  );

  return { status: res.status, body: await res.json() };
}

async function findBySource(
  token = fx.token,
  slug = fx.slug,
  externalId = SOURCE.externalId,
) {
  const qs = new URLSearchParams({
    kind: "github",
    instance: "GitHub.com",
    externalId,
  });
  const res = await routes.bySource(
    ext("GET", `/api/v1/ext/projects/${slug}/tasks/by-source?${qs}`, token),
    { params: Promise.resolve({ slug }) },
  );

  return { status: res.status, body: await res.json() };
}

async function bind(
  taskId: string,
  body: unknown,
  token = fx.token,
  slug = fx.slug,
) {
  const res = await routes.bind(
    ext(
      "PUT",
      `/api/v1/ext/projects/${slug}/tasks/${taskId}/source`,
      token,
      body,
    ),
    { params: Promise.resolve({ slug, taskId }) },
  );

  return { status: res.status, body: await res.json() };
}

async function detach(number: number, userId: string | null) {
  sessionRef.value = userId ? { user: { id: userId } } : null;
  const res = await routes.detach(
    new NextRequest(
      `http://localhost/api/projects/${fx.slug}/tasks/${number}/source`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ slug: fx.slug, number: String(number) }) },
  );

  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_task_source_test",
  });
  db = testDatabase.db;
  fx.slug = `wire-${randomUUID().slice(0, 8)}`;
  fx.otherSlug = `wire-other-${randomUUID().slice(0, 8)}`;
  fx.projectId = await seedProject(fx.slug);
  const otherProjectId = await seedProject(fx.otherSlug);

  fx.memberId = randomUUID();
  fx.viewerId = randomUUID();
  await db.insert(schema.users).values(
    [fx.memberId, fx.viewerId].map((id) => ({
      id,
      email: `${id.slice(0, 8)}@example.test`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    })),
  );
  await db.insert(schema.projectMembers).values([
    { projectId: fx.projectId, userId: fx.memberId, role: "member" },
    { projectId: fx.projectId, userId: fx.viewerId, role: "viewer" },
  ]);
  fx.token = (
    await issueToken(
      {
        projectId: fx.projectId,
        name: "intake",
        scopes: ["tasks:create", "tasks:read", "tasks:update"],
      },
      db,
    )
  ).secret;
  fx.readOnlyToken = (
    await issueToken(
      { projectId: fx.projectId, name: "reader", scopes: ["tasks:read"] },
      db,
    )
  ).secret;
  fx.otherProjectToken = (
    await issueToken(
      {
        projectId: otherProjectId,
        name: "foreign",
        scopes: ["tasks:create", "tasks:read", "tasks:update"],
      },
      db,
    )
  ).secret;

  routes = {
    create: (await import("@/app/api/v1/ext/projects/[slug]/tasks/route")).POST,
    bySource: (
      await import("@/app/api/v1/ext/projects/[slug]/tasks/by-source/route")
    ).GET,
    bind: (
      await import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/source/route")
    ).PUT,
    detach: (
      await import("@/app/api/projects/[slug]/tasks/[number]/source/route")
    ).DELETE,
  };
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("ext task source wire contract (S5, S8)", () => {
  it("create returns the normalized binding, lookup finds it, and a repeat create is 409 naming the task", async () => {
    const created = await createWithSource({
      ...SOURCE,
      instance: "GitHub.COM",
    });

    expect(created.status).toBe(201);
    expect(created.body.source).toEqual(SOURCE);

    const found = await findBySource();

    expect(found).toMatchObject({
      status: 200,
      body: { task: { id: created.body.taskId, source: SOURCE } },
    });

    const repeat = await createWithSource(SOURCE);

    expect(repeat).toMatchObject({
      status: 409,
      body: {
        code: "CONFLICT",
        details: {
          reason: "source_already_bound",
          existingTaskId: created.body.taskId,
        },
      },
    });
  });

  it("lookup answers task:null for an unbound identity and 422 for an invalid query", async () => {
    expect(await findBySource(fx.token, fx.slug, "I_unbound")).toEqual({
      status: 200,
      body: { task: null },
    });

    const res = await routes.bySource(
      ext(
        "GET",
        `/api/v1/ext/projects/${fx.slug}/tasks/by-source?kind=GitHub&instance=x&externalId=1`,
        fx.token,
      ),
      { params: Promise.resolve({ slug: fx.slug }) },
    );

    expect(res.status).toBe(422);
  });

  it("create refuses an invalid source with 422 CONFIG and creates nothing", async () => {
    const refused = await createWithSource({
      ...SOURCE,
      externalId: "I_bad",
      url: "http://insecure",
    });

    expect(refused).toMatchObject({ status: 422, body: { code: "CONFIG" } });
    expect((await findBySource(fx.token, fx.slug, "I_bad")).body).toEqual({
      task: null,
    });
  });

  it("bind returns the task with its source, is idempotent, and maps both conflicts to 409", async () => {
    const plain = await routes.create(
      ext("POST", `/api/v1/ext/projects/${fx.slug}/tasks`, fx.token, {
        title: "Plain",
        prompt: "p",
      }),
      { params: Promise.resolve({ slug: fx.slug }) },
    );
    const { taskId } = await plain.json();
    const source = { ...SOURCE, externalId: "I_bind_wire" };

    expect(await bind(taskId, source)).toMatchObject({
      status: 200,
      body: { task: { id: taskId, source } },
    });
    expect((await bind(taskId, source)).status).toBe(200);
    expect(
      await bind(taskId, { ...source, externalId: "I_other" }),
    ).toMatchObject({
      status: 409,
      body: { details: { reason: "source_conflict" } },
    });
    expect(
      await bind(taskId, { ...source, expectedRevision: 99 }),
    ).toMatchObject({
      status: 409,
      body: { details: { reason: "stale_revision" } },
    });
    expect(await bind(randomUUID(), source)).toMatchObject({ status: 404 });
  });

  it("refuses source from a librarian token (S8)", async () => {
    const ownerId = randomUUID();
    const conversationId = randomUUID();
    const segmentId = randomUUID();
    const messageId = randomUUID();
    const turnId = randomUUID();

    await db.insert(schema.users).values({
      id: ownerId,
      email: `${ownerId.slice(0, 8)}@example.test`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    });
    await db
      .insert(schema.projectMembers)
      .values({ projectId: fx.projectId, userId: ownerId, role: "owner" });
    await db
      .insert(schema.librarianConversations)
      .values({ id: conversationId, userId: ownerId });
    await db.insert(schema.librarianSegments).values({
      id: segmentId,
      conversationId,
      ordinal: 0,
      startedAt: new Date(),
    });
    await db.insert(schema.librarianMessages).values({
      id: messageId,
      conversationId,
      segmentId,
      seq: 1n,
      authorKind: "owner",
      body: "create",
    });
    await db.insert(schema.librarianTurns).values({
      id: turnId,
      conversationId,
      segmentId,
      messageId,
      variant: "owner_message",
      status: "running",
      contextSnapshotId: randomUUID(),
    });
    const librarian = await issueLibrarianTurnToken(
      {
        ownerUserId: ownerId,
        turnId,
        scopes: ["tasks:create"],
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );
    const req = ext(
      "POST",
      `/api/v1/ext/projects/${fx.slug}/tasks`,
      librarian.secret,
      {
        title: "From chat",
        statement: {
          context: "c",
          goal: "g",
          acceptance: ["a"],
          constraints: [],
          outOfScope: [],
          links: [],
          openQuestions: [],
        },
        source: { ...SOURCE, externalId: "I_librarian" },
      },
    );

    req.headers.set("Idempotency-Key", "librarian-source-1");
    const res = await routes.create(req, {
      params: Promise.resolve({ slug: fx.slug }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      details: { reason: "source_not_allowed_for_token" },
    });
  });
});

describe("authorization (A1)", () => {
  it("a token of another project gets 404 on every source route", async () => {
    const created = await createWithSource({
      ...SOURCE,
      externalId: "I_scoped",
    });

    expect((await findBySource(fx.otherProjectToken)).status).toBe(404);
    expect(
      (await bind(created.body.taskId, SOURCE, fx.otherProjectToken)).status,
    ).toBe(404);
  });

  it("a token without tasks:update cannot bind but can look up", async () => {
    const created = await createWithSource({
      ...SOURCE,
      externalId: "I_reader",
    });

    expect(
      (await bind(created.body.taskId, SOURCE, fx.readOnlyToken)).status,
    ).toBe(403);
    expect(
      (await findBySource(fx.readOnlyToken, fx.slug, "I_reader")).status,
    ).toBe(200);
  });

  it("detach is session-only: anonymous 401, viewer 403, member 200 then 409 source_not_bound", async () => {
    const created = await createWithSource({
      ...SOURCE,
      externalId: "I_detach_wire",
    });
    const [task] = await db
      .select({ number: schema.tasks.number })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, created.body.taskId));

    expect((await detach(task.number, null)).status).toBe(401);
    expect((await detach(task.number, fx.viewerId)).status).toBe(403);
    expect(await detach(task.number, fx.memberId)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await detach(task.number, fx.memberId)).toMatchObject({
      status: 409,
      body: { details: { reason: "source_not_bound" } },
    });
    expect(
      (await findBySource(fx.token, fx.slug, "I_detach_wire")).body,
    ).toEqual({ task: null });
  });
});
