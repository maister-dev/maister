// ADR-075 T4.1 — HTTP wiring for the social-board routes: auth-first, role
// gates (commentTask/manageTaskRelations = member; reads = viewer), 404
// existence-hide on slug/number, recipient-owned inbox reads. Domain
// semantics live in lib/social/__tests__/social-domain.integration.test.ts.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { createTask } from "@/lib/services/tasks";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let commentsGET: typeof import("@/app/api/projects/[slug]/tasks/[number]/comments/route").GET;
let commentsPOST: typeof import("@/app/api/projects/[slug]/tasks/[number]/comments/route").POST;
let relationsPOST: typeof import("@/app/api/projects/[slug]/tasks/[number]/relations/route").POST;
let relationsDELETE: typeof import("@/app/api/projects/[slug]/tasks/[number]/relations/route").DELETE;
let subscriptionPOST: typeof import("@/app/api/projects/[slug]/tasks/[number]/subscription/route").POST;
let subscriptionDELETE: typeof import("@/app/api/projects/[slug]/tasks/[number]/subscription/route").DELETE;
let inboxReadPATCH: typeof import("@/app/api/inbox/[itemId]/read/route").PATCH;
let inboxReadAllPOST: typeof import("@/app/api/inbox/read-all/route").POST;

const SLUG = "social-routes";

const fx: {
  projectId: string;
  flowId: string;
  ownerId: string;
  memberId: string;
  viewerId: string;
  taskNumber: number;
  taskId: string;
  otherTaskNumber: number;
} = {
  projectId: "",
  flowId: "",
  ownerId: "",
  memberId: "",
  viewerId: "",
  taskNumber: 0,
  taskId: "",
  otherTaskNumber: 0,
};

function actAs(userId: string | null): void {
  sessionRef.value = userId ? { user: { id: userId } } : null;
}

function jsonRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });
}

function routeParams(slug: string, number: number | string) {
  return { params: Promise.resolve({ slug, number: String(number) }) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("social_routes_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();
  fx.flowId = randomUUID();
  fx.ownerId = randomUUID();
  fx.memberId = randomUUID();
  fx.viewerId = randomUUID();

  await db.insert(schema.users).values(
    [
      { id: fx.ownerId, role: "member", suffix: "owner" },
      { id: fx.memberId, role: "member", suffix: "member" },
      { id: fx.viewerId, role: "member", suffix: "viewer" },
    ].map((u) => ({
      id: u.id,
      email: `${u.suffix}-${u.id.slice(0, 8)}@example.test`,
      name: `Social ${u.suffix}`,
      role: u.role,
      accountStatus: "active",
    })),
  );
  await db.insert(schema.projects).values({
    id: fx.projectId,
    slug: SLUG,
    name: "Social Routes",
    repoPath: `/tmp/${SLUG}`,
    maisterYamlPath: `/tmp/${SLUG}/maister.yaml`,
    taskKey: "SRT",
  });
  await db.insert(schema.projectMembers).values([
    { id: randomUUID(), projectId: fx.projectId, userId: fx.ownerId, role: "owner" },
    { id: randomUUID(), projectId: fx.projectId, userId: fx.memberId, role: "member" },
    { id: randomUUID(), projectId: fx.projectId, userId: fx.viewerId, role: "viewer" },
  ]);
  await db.insert(schema.flows).values({
    id: fx.flowId,
    projectId: fx.projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  const created = await createTask(
    { title: "main task", prompt: "p", flowId: fx.flowId },
    { projectId: fx.projectId, actorUserId: fx.ownerId },
    db,
  );

  fx.taskId = created.taskId;
  fx.taskNumber = created.number;

  const other = await createTask(
    { title: "other task", prompt: "p", flowId: fx.flowId },
    { projectId: fx.projectId, actorUserId: fx.ownerId },
    db,
  );

  fx.otherTaskNumber = other.number;

  const routes = await import(
    "@/app/api/projects/[slug]/tasks/[number]/comments/route"
  );
  const relations = await import(
    "@/app/api/projects/[slug]/tasks/[number]/relations/route"
  );
  const subscription = await import(
    "@/app/api/projects/[slug]/tasks/[number]/subscription/route"
  );

  commentsGET = routes.GET;
  commentsPOST = routes.POST;
  relationsPOST = relations.POST;
  relationsDELETE = relations.DELETE;
  subscriptionPOST = subscription.POST;
  subscriptionDELETE = subscription.DELETE;
  inboxReadPATCH = (await import("@/app/api/inbox/[itemId]/read/route")).PATCH;
  inboxReadAllPOST = (await import("@/app/api/inbox/read-all/route")).POST;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("comments routes", () => {
  it("member POSTs a comment; mentions expand; actor label is resolved", async () => {
    actAs(fx.memberId);

    const res = await commentsPOST(
      jsonRequest("POST", { body: `see SRT-${fx.otherTaskNumber}` }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(res.status).toBe(201);

    const { comment } = (await res.json()) as { comment: any };

    expect(comment.body).toBe(
      `see [SRT-${fx.otherTaskNumber}](/projects/${SLUG}/tasks/${fx.otherTaskNumber})`,
    );
    expect(comment.actor).toMatchObject({
      type: "user",
      id: fx.memberId,
      label: "Social member",
    });
  });

  it("viewer can GET but cannot POST (403 UNAUTHORIZED)", async () => {
    actAs(fx.viewerId);

    const list = await commentsGET(
      jsonRequest("GET"),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { comments: unknown[] }).comments.length,
    ).toBeGreaterThan(0);

    const post = await commentsPOST(
      jsonRequest("POST", { body: "nope" }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(post.status).toBe(403);
    expect(((await post.json()) as { code: string }).code).toBe(
      "UNAUTHORIZED",
    );
  });

  it("unauthenticated callers get 401 before any existence probe", async () => {
    actAs(null);

    const res = await commentsGET(
      jsonRequest("GET"),
      routeParams("does-not-exist", 1),
    );

    expect(res.status).toBe(401);
  });

  it("unknown slug or number answers 404; malformed number too", async () => {
    actAs(fx.memberId);

    for (const [slug, number] of [
      ["ghost-project", fx.taskNumber],
      [SLUG, 999_999],
      [SLUG, "12abc"],
    ] as const) {
      const res = await commentsGET(
        jsonRequest("GET"),
        routeParams(slug, number),
      );

      expect(res.status).toBe(404);
    }
  });

  it("rejects an empty body with CONFIG (400, runs-family mapping)", async () => {
    actAs(fx.memberId);

    const res = await commentsPOST(
      jsonRequest("POST", { body: "" }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
  });
});

describe("relations routes", () => {
  it("member adds and removes a relation; viewer is refused", async () => {
    actAs(fx.memberId);

    const add = await relationsPOST(
      jsonRequest("POST", { kind: "blocks", toNumber: fx.otherTaskNumber }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(add.status).toBe(200);
    expect(((await add.json()) as { ok: boolean }).ok).toBe(true);

    actAs(fx.viewerId);

    const refused = await relationsPOST(
      jsonRequest("POST", { kind: "blocks", toNumber: fx.otherTaskNumber }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(refused.status).toBe(403);

    actAs(fx.memberId);

    const remove = await relationsDELETE(
      jsonRequest("DELETE", { kind: "blocks", toNumber: fx.otherTaskNumber }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(remove.status).toBe(200);
  });

  it("missing counterpart → 404; self-relation → 400 CONFIG; bad kind → 400", async () => {
    actAs(fx.memberId);

    const missing = await relationsPOST(
      jsonRequest("POST", { kind: "blocks", toNumber: 424_242 }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(missing.status).toBe(404);

    const self = await relationsPOST(
      jsonRequest("POST", { kind: "blocks", toNumber: fx.taskNumber }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(self.status).toBe(400);
    expect(((await self.json()) as { code: string }).code).toBe("CONFIG");

    const badKind = await relationsPOST(
      jsonRequest("POST", { kind: "relates_to", toNumber: fx.otherTaskNumber }),
      routeParams(SLUG, fx.taskNumber),
    );

    expect(badKind.status).toBe(400);
  });
});

describe("subscription routes", () => {
  it("follow + unfollow are recipient-owned and idempotent", async () => {
    actAs(fx.viewerId);

    for (let i = 0; i < 2; i += 1) {
      const res = await subscriptionPOST(
        jsonRequest("POST"),
        routeParams(SLUG, fx.taskNumber),
      );

      expect(res.status).toBe(200);
    }

    const subs = await pool.query(
      `select reason from task_subscribers where task_id = $1 and subscriber_id = $2`,
      [fx.taskId, fx.viewerId],
    );

    expect(subs.rows).toEqual([{ reason: "manual" }]);

    for (let i = 0; i < 2; i += 1) {
      const res = await subscriptionDELETE(
        jsonRequest("DELETE"),
        routeParams(SLUG, fx.taskNumber),
      );

      expect(res.status).toBe(200);
    }

    const after = await pool.query(
      `select count(*)::int as c from task_subscribers where task_id = $1 and subscriber_id = $2`,
      [fx.taskId, fx.viewerId],
    );

    expect(after.rows[0].c).toBe(0);
  });
});

describe("inbox routes", () => {
  async function seedInboxItem(recipientId: string): Promise<string> {
    const id = randomUUID();

    await pool.query(
      `insert into inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
       values ($1, 'user', $2, $3, $4, 'comment_added', '{}')`,
      [id, recipientId, fx.projectId, fx.taskId],
    );

    return id;
  }

  it("marks own items read; foreign items answer 404 (existence-hide)", async () => {
    const mine = await seedInboxItem(fx.memberId);
    const foreign = await seedInboxItem(fx.ownerId);

    actAs(fx.memberId);

    const ok = await inboxReadPATCH(jsonRequest("PATCH"), {
      params: Promise.resolve({ itemId: mine }),
    });

    expect(ok.status).toBe(200);

    const denied = await inboxReadPATCH(jsonRequest("PATCH"), {
      params: Promise.resolve({ itemId: foreign }),
    });

    expect(denied.status).toBe(404);

    const ghost = await inboxReadPATCH(jsonRequest("PATCH"), {
      params: Promise.resolve({ itemId: randomUUID() }),
    });

    expect(ghost.status).toBe(404);
  });

  it("read-all marks only the caller's unread items and reports the count", async () => {
    const a = await seedInboxItem(fx.viewerId);
    const b = await seedInboxItem(fx.viewerId);
    const foreign = await seedInboxItem(fx.ownerId);

    actAs(fx.viewerId);

    const res = await inboxReadAllPOST();

    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; updated: number };

    expect(body.ok).toBe(true);
    expect(body.updated).toBe(2);

    const rows = await pool.query(
      `select id, read_at from inbox_items where id = any($1::text[]) order by id`,
      [[a, b, foreign].sort()],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.read_at]));

    expect(byId.get(a)).not.toBeNull();
    expect(byId.get(b)).not.toBeNull();
    expect(byId.get(foreign)).toBeNull();
  });
});
