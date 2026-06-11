// ADR-075 D12 — ext comment routes: scope enforcement, in-tx success audit
// with the new scope labels, and token→actor mapping (user-owned token acts
// as the user; ownerless project token acts as system with {via, tokenId}
// recorded in the comment-activity payload).

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

import { issueToken } from "@/lib/tokens/issue";
import * as schemaModule from "@/lib/db/schema";
import { createTask } from "@/lib/services/tasks";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let GET: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/route").GET;
let POST: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/route").POST;

const SLUG = "ext-comments";

const fx: {
  projectId: string;
  flowId: string;
  ownerId: string;
  taskId: string;
  otherProjectId: string;
  foreignTaskId: string;
  userToken: string;
  userTokenId: string;
  projectToken: string;
  projectTokenId: string;
  readOnlyToken: string;
} = {
  projectId: "",
  flowId: "",
  ownerId: "",
  taskId: "",
  otherProjectId: "",
  foreignTaskId: "",
  userToken: "",
  userTokenId: "",
  projectToken: "",
  projectTokenId: "",
  readOnlyToken: "",
};

function request(
  method: string,
  token: string,
  body?: unknown,
): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/test", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
  });
}

function routeParams(slug: string, taskId: string) {
  return { params: Promise.resolve({ slug, taskId }) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_comments_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();
  fx.otherProjectId = randomUUID();
  fx.flowId = randomUUID();
  fx.ownerId = randomUUID();

  await db.insert(schema.users).values({
    id: fx.ownerId,
    email: `owner-${fx.ownerId.slice(0, 8)}@example.test`,
    name: "Token Owner",
    role: "member",
    accountStatus: "active",
  });
  await db.insert(schema.projects).values([
    {
      id: fx.projectId,
      slug: SLUG,
      name: "Ext Comments",
      repoPath: `/tmp/${SLUG}`,
      maisterYamlPath: `/tmp/${SLUG}/maister.yaml`,
      taskKey: "EXC",
    },
    {
      id: fx.otherProjectId,
      slug: `${SLUG}-other`,
      name: "Ext Comments Other",
      repoPath: `/tmp/${SLUG}-other`,
      maisterYamlPath: `/tmp/${SLUG}-other/maister.yaml`,
      taskKey: "EXO",
    },
  ]);
  await db.insert(schema.flows).values([
    {
      id: fx.flowId,
      projectId: fx.projectId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/bugfix",
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    },
    {
      id: randomUUID(),
      projectId: fx.otherProjectId,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/bugfix",
      manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
      schemaVersion: 1,
    },
  ]);

  const created = await createTask(
    { title: "ext task", prompt: "p", flowId: fx.flowId },
    { projectId: fx.projectId, actorUserId: fx.ownerId },
    db,
  );

  fx.taskId = created.taskId;

  // A task in ANOTHER project — cross-project access must existence-hide.
  const foreignFlow = await pool.query(
    `select id from flows where project_id = $1`,
    [fx.otherProjectId],
  );
  const foreign = await createTask(
    { title: "foreign task", prompt: "p", flowId: foreignFlow.rows[0].id },
    { projectId: fx.otherProjectId, actorUserId: null },
    db,
  );

  fx.foreignTaskId = foreign.taskId;

  const userToken = await issueToken(
    {
      projectId: fx.projectId,
      name: "user token",
      tokenKind: "user",
      ownerUserId: fx.ownerId,
      scopes: ["comments:read", "comments:create"],
    },
    db,
  );

  fx.userToken = userToken.secret;
  fx.userTokenId = userToken.tokenId;

  const projectToken = await issueToken(
    {
      projectId: fx.projectId,
      name: "project token",
      tokenKind: "project",
      scopes: ["comments:create", "comments:read"],
    },
    db,
  );

  fx.projectToken = projectToken.secret;
  fx.projectTokenId = projectToken.tokenId;

  const readOnly = await issueToken(
    {
      projectId: fx.projectId,
      name: "read-only token",
      tokenKind: "project",
      scopes: ["comments:read"],
    },
    db,
  );

  fx.readOnlyToken = readOnly.secret;

  const routes = await import(
    "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/comments/route"
  );

  GET = routes.GET;
  POST = routes.POST;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("ext comment routes (ADR-075 D12)", () => {
  it("user-owned token posts as ('user', owner) and the audit row carries comments:create", async () => {
    const res = await POST(
      request("POST", fx.userToken, { body: "from a user token" }),
      routeParams(SLUG, fx.taskId),
    );

    expect(res.status).toBe(201);

    const { comment } = (await res.json()) as { comment: any };

    expect(comment.actor).toMatchObject({
      type: "user",
      id: fx.ownerId,
      label: "Token Owner",
    });

    const audit = await pool.query(
      `select scope_used, result, status_code from token_audit_log
       where token_id = $1 and result = 'ok' order by created_at desc limit 1`,
      [fx.userTokenId],
    );

    expect(audit.rows[0]).toEqual({
      scope_used: "comments:create",
      result: "ok",
      status_code: 201,
    });
  });

  it("ownerless project token posts as system with {via, tokenId} in the activity payload", async () => {
    const res = await POST(
      request("POST", fx.projectToken, { body: "from automation" }),
      routeParams(SLUG, fx.taskId),
    );

    expect(res.status).toBe(201);

    const { comment } = (await res.json()) as { comment: any };

    expect(comment.actor).toMatchObject({
      type: "system",
      id: null,
      label: "system",
    });

    const activity = await pool.query(
      `select payload from task_activity
       where task_id = $1 and event_kind = 'comment_added'
         and payload->>'commentId' = $2`,
      [fx.taskId, comment.id],
    );

    expect(activity.rows[0].payload).toMatchObject({
      via: "ext",
      tokenId: fx.projectTokenId,
    });
  });

  it("refuses comments:create without the scope (403, scopes not revealed)", async () => {
    const res = await POST(
      request("POST", fx.readOnlyToken, { body: "nope" }),
      routeParams(SLUG, fx.taskId),
    );

    expect(res.status).toBe(403);

    const body = (await res.json()) as { code: string; message: string };

    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.message).not.toContain("comments:read");
  });

  it("lists comments with comments:read; bodies come back expanded", async () => {
    const res = await GET(
      request("GET", fx.readOnlyToken),
      routeParams(SLUG, fx.taskId),
    );

    expect(res.status).toBe(200);

    const { comments } = (await res.json()) as { comments: any[] };

    expect(comments.length).toBeGreaterThanOrEqual(2);
    expect(comments[0].body).toBe("from a user token");
  });

  it("cross-project taskId existence-hides with 404", async () => {
    const res = await GET(
      request("GET", fx.userToken),
      routeParams(SLUG, fx.foreignTaskId),
    );

    expect(res.status).toBe(404);
  });

  it("rejects an invalid bearer with 401", async () => {
    const res = await GET(
      request("GET", "mai_definitely-not-a-token"),
      routeParams(SLUG, fx.taskId),
    );

    expect(res.status).toBe(401);
  });

  it("rejects an oversized body with 422 CONFIG", async () => {
    const res = await POST(
      request("POST", fx.userToken, { body: "x".repeat(10_001) }),
      routeParams(SLUG, fx.taskId),
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
  });
});
