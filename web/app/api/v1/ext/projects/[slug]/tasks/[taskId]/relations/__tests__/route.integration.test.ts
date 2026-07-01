// M34 (ADR-089 D8) — ext relations ops: list/add/remove mirroring the web
// route (`toNumber` resolved strictly within the URL-param project),
// idempotent duplicates/removals, scope enforcement, token-derived actor.

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
import { issueToken } from "@/lib/tokens/issue";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

type Routes =
  typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/relations/route");

let GET: Routes["GET"];
let POST: Routes["POST"];
let DELETE: Routes["DELETE"];

const SLUG = "ext-relations";

const fx = {
  projectId: "",
  flowId: "",
  ownerId: "",
  fromTaskId: "",
  toTaskId: "",
  toNumber: 0,
  fullToken: "",
  readOnlyToken: "",
};

function request(method: string, token: string, body?: unknown): NextRequest {
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
    .withDatabase("ext_relations_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();
  fx.flowId = randomUUID();
  fx.ownerId = randomUUID();

  await db.insert(schema.users).values({
    id: fx.ownerId,
    email: `owner-${fx.ownerId.slice(0, 8)}@example.test`,
    name: "Token Owner",
    role: "member",
    accountStatus: "active",
  });
  await db.insert(schema.projects).values({
    id: fx.projectId,
    slug: SLUG,
    name: "Ext Relations",
    repoPath: `/tmp/${SLUG}`,
    maisterYamlPath: `/tmp/${SLUG}/maister.yaml`,
    taskKey: "EXR",
  });
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

  const from = await createTask(
    { title: "from", prompt: "p", flowId: fx.flowId },
    { projectId: fx.projectId, actorUserId: fx.ownerId },
    db,
  );
  const to = await createTask(
    { title: "to", prompt: "p", flowId: fx.flowId },
    { projectId: fx.projectId, actorUserId: fx.ownerId },
    db,
  );

  fx.fromTaskId = from.taskId;
  fx.toTaskId = to.taskId;
  fx.toNumber = to.number;

  const fullToken = await issueToken(
    {
      projectId: fx.projectId,
      name: "relations token",
      tokenKind: "project",
      scopes: ["relations:read", "relations:create", "relations:delete"],
    },
    db,
  );

  fx.fullToken = fullToken.secret;

  const readOnly = await issueToken(
    {
      projectId: fx.projectId,
      name: "read-only token",
      tokenKind: "project",
      scopes: ["relations:read"],
    },
    db,
  );

  fx.readOnlyToken = readOnly.secret;

  const routes = await import(
    "@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/relations/route"
  );

  GET = routes.GET;
  POST = routes.POST;
  DELETE = routes.DELETE;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("ext relations ops", () => {
  it("adds a relation (201), lists it from both ends, and dedups idempotently", async () => {
    const add = await POST(
      request("POST", fx.fullToken, { kind: "blocks", toNumber: fx.toNumber }),
      routeParams(SLUG, fx.fromTaskId),
    );

    expect(add.status).toBe(201);
    expect(await add.json()).toEqual({ ok: true, created: true });

    const dup = await POST(
      request("POST", fx.fullToken, { kind: "blocks", toNumber: fx.toNumber }),
      routeParams(SLUG, fx.fromTaskId),
    );

    expect(dup.status).toBe(201);
    expect(await dup.json()).toEqual({ ok: true, created: false });

    const listFrom = await GET(
      request("GET", fx.readOnlyToken),
      routeParams(SLUG, fx.fromTaskId),
    );
    const fromBody = (await listFrom.json()) as { relations: any[] };

    expect(listFrom.status).toBe(200);
    expect(fromBody.relations).toHaveLength(1);
    expect(fromBody.relations[0]).toMatchObject({
      kind: "blocks",
      role: "from",
      other: { taskId: fx.toTaskId, number: fx.toNumber, taskKey: "EXR" },
    });

    const listTo = await GET(
      request("GET", fx.readOnlyToken),
      routeParams(SLUG, fx.toTaskId),
    );
    const toBody = (await listTo.json()) as { relations: any[] };

    expect(toBody.relations[0]).toMatchObject({ kind: "blocks", role: "to" });
  });

  it("removes the relation (200) and treats a second removal as a no-op", async () => {
    const remove = await DELETE(
      request("DELETE", fx.fullToken, {
        kind: "blocks",
        toNumber: fx.toNumber,
      }),
      routeParams(SLUG, fx.fromTaskId),
    );

    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({ ok: true, removed: true });

    const again = await DELETE(
      request("DELETE", fx.fullToken, {
        kind: "blocks",
        toNumber: fx.toNumber,
      }),
      routeParams(SLUG, fx.fromTaskId),
    );

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, removed: false });
  });

  it("refuses a write with a read-only scope (403) and a missing target (404)", async () => {
    const forbidden = await POST(
      request("POST", fx.readOnlyToken, {
        kind: "blocks",
        toNumber: fx.toNumber,
      }),
      routeParams(SLUG, fx.fromTaskId),
    );

    expect(forbidden.status).toBe(403);

    const missing = await POST(
      request("POST", fx.fullToken, { kind: "blocks", toNumber: 99_999 }),
      routeParams(SLUG, fx.fromTaskId),
    );

    expect(missing.status).toBe(404);
  });

  it("rejects a self-relation with 422 (CONFIG)", async () => {
    const fromNumberRow = await pool.query(
      `SELECT number FROM tasks WHERE id = $1`,
      [fx.fromTaskId],
    );
    const res = await POST(
      request("POST", fx.fullToken, {
        kind: "blocks",
        toNumber: fromNumberRow.rows[0].number,
      }),
      routeParams(SLUG, fx.fromTaskId),
    );

    expect(res.status).toBe(422);
  });

  it("ADR-121 §4.6: refuses a gating cycle with 409 (CONFLICT) on the agent-token surface", async () => {
    // A blocks B (201), then B blocks A would close a cycle → CONFLICT → 409,
    // proving the domain CONFLICT maps through the ext-token route (INV-6).
    const forward = await POST(
      request("POST", fx.fullToken, { kind: "blocks", toNumber: fx.toNumber }),
      routeParams(SLUG, fx.fromTaskId),
    );

    expect(forward.status).toBe(201);

    const fromNumberRow = await pool.query(
      `SELECT number FROM tasks WHERE id = $1`,
      [fx.fromTaskId],
    );
    const cycle = await POST(
      request("POST", fx.fullToken, {
        kind: "blocks",
        toNumber: fromNumberRow.rows[0].number,
      }),
      routeParams(SLUG, fx.toTaskId),
    );

    expect(cycle.status).toBe(409);
  });
});
