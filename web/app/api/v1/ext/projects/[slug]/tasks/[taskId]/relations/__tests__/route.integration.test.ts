// M34 (ADR-089 D8) — ext relations ops: list/add/remove mirroring the web
// route (`toNumber` resolved strictly within the URL-param project),
// idempotent duplicates/removals, scope enforcement, token-derived actor.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import { createTask } from "@/lib/services/tasks";
import { issueToken } from "@/lib/tokens/issue";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
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
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_relations_test",
  });

  pool = testDatabase.pool;
  db = testDatabase.db;

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
    manifest: {
      schemaVersion: 1,
      name: "Bugfix",
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    },
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
  await testDatabase?.stop();
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

// ADR-155: cross-project targets addressed by the platform-unique KEY-N.
describe("ext relations — cross-project targets (ADR-155)", () => {
  const sib = {
    projectId: "",
    flowId: "",
    taskId: "",
    taskKey: "EXS",
    memberId: "",
    userToken: "",
    archivedProjectId: "",
    archivedTaskKey: "EXZ",
  };

  async function seedProject(
    id: string,
    slug: string,
    taskKey: string,
    archivedAt: Date | null,
  ): Promise<string> {
    const flowId = randomUUID();

    await db.insert(schema.projects).values({
      id,
      slug,
      name: slug,
      repoPath: `/tmp/${slug}`,
      maisterYamlPath: `/tmp/${slug}/maister.yaml`,
      taskKey,
      archivedAt,
    });
    await db.insert(schema.flows).values({
      id: flowId,
      projectId: id,
      flowRefId: "bugfix",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/bugfix",
      manifest: {
        schemaVersion: 1,
        name: "Bugfix",
        nodes: [
          {
            id: "run",
            type: "cli",
            action: { command: "true" },
            transitions: { success: "done" },
          },
        ],
      },
      schemaVersion: 1,
    });

    return flowId;
  }

  beforeAll(async () => {
    sib.projectId = randomUUID();
    sib.archivedProjectId = randomUUID();
    sib.memberId = randomUUID();

    sib.flowId = await seedProject(
      sib.projectId,
      "ext-relations-sibling",
      sib.taskKey,
      null,
    );

    const archivedFlowId = await seedProject(
      sib.archivedProjectId,
      "ext-relations-archived",
      sib.archivedTaskKey,
      new Date(),
    );

    await db.insert(schema.users).values({
      id: sib.memberId,
      email: `member-${sib.memberId.slice(0, 8)}@example.test`,
      name: "Cross Member",
      role: "member",
      accountStatus: "active",
    });

    // A NULL-project user token carries the OWNER's RBAC, re-checked per
    // request on both ends — so the owner must be a member of both projects.
    for (const projectId of [fx.projectId, sib.projectId]) {
      await db.insert(schema.projectMembers).values({
        id: randomUUID(),
        projectId,
        userId: sib.memberId,
        role: "admin",
      });
    }

    const target = await createTask(
      { title: "sibling target", prompt: "p", flowId: sib.flowId },
      { projectId: sib.projectId, actorUserId: sib.memberId },
      db,
    );

    sib.taskId = target.taskId;

    await createTask(
      { title: "archived target", prompt: "p", flowId: archivedFlowId },
      { projectId: sib.archivedProjectId, actorUserId: null },
      db,
    );

    const userToken = await issueToken(
      {
        projectId: null,
        name: "cross-project user token",
        tokenKind: "user",
        ownerUserId: sib.memberId,
        scopes: ["relations:read", "relations:create", "relations:delete"],
      },
      db,
    );

    sib.userToken = userToken.secret;
  }, 120_000);

  async function freshFromTask(title: string): Promise<string> {
    const t = await createTask(
      { title, prompt: "p", flowId: fx.flowId },
      { projectId: fx.projectId, actorUserId: fx.ownerId },
      db,
    );

    return t.taskId;
  }

  it("lets a NULL-project user token relate across projects via toTaskKey", async () => {
    const fromTaskId = await freshFromTask("xproj ok");

    const res = await POST(
      request("POST", sib.userToken, {
        kind: "blocks",
        toTaskKey: `${sib.taskKey}-1`,
      }),
      routeParams(SLUG, fromTaskId),
    );

    expect(res.status).toBe(201);

    const rows = await pool.query(
      "select project_id, to_task_id from task_relations where from_task_id = $1",
      [fromTaskId],
    );

    expect(rows.rows).toHaveLength(1);
    // The row stays owned by the FROM-task's project (ADR-155 D3).
    expect(rows.rows[0].project_id).toBe(fx.projectId);
    expect(rows.rows[0].to_task_id).toBe(sib.taskId);
  });

  it("refuses a PROJECT-BOUND token crossing projects with 403 AND writes the audit row", async () => {
    const fromTaskId = await freshFromTask("xproj denied");

    const before = await pool.query(
      "select count(*)::int as n from token_audit_log where status_code = 403 and project_id = $1",
      [sib.projectId],
    );

    const res = await POST(
      request("POST", fx.fullToken, {
        kind: "blocks",
        toTaskKey: `${sib.taskKey}-1`,
      }),
      routeParams(SLUG, fromTaskId),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });

    // The refusal names the project actually reached for — the generic handler
    // can only audit the URL project, so this row is the one that matters.
    const after = await pool.query(
      "select count(*)::int as n from token_audit_log where status_code = 403 and project_id = $1",
      [sib.projectId],
    );

    expect(after.rows[0].n).toBe(before.rows[0].n + 1);

    const rows = await pool.query(
      "select id from task_relations where from_task_id = $1",
      [fromTaskId],
    );

    expect(rows.rows).toHaveLength(0);
  });

  // An authz throw inside `work` escapes handleExt (it catches only
  // TokenAuthError), so an unguarded requireProjectActionForUser surfaces as an
  // unaudited 500 instead of the documented 403.
  it("403s (never 500) when the NULL-project token's owner lacks rights on the TARGET", async () => {
    const stranger = randomUUID();

    await db.insert(schema.users).values({
      id: stranger,
      email: `stranger-${stranger.slice(0, 8)}@example.test`,
      name: "No Sibling Rights",
      role: "member",
      accountStatus: "active",
    });
    // Member of the URL project ONLY — no membership in the sibling.
    await db.insert(schema.projectMembers).values({
      id: randomUUID(),
      projectId: fx.projectId,
      userId: stranger,
      role: "admin",
    });

    const token = await issueToken(
      {
        projectId: null,
        name: "stranger user token",
        tokenKind: "user",
        ownerUserId: stranger,
        scopes: ["relations:create"],
      },
      db,
    );

    const fromTaskId = await freshFromTask("xproj stranger");
    const res = await POST(
      request("POST", token.secret, {
        kind: "blocks",
        toTaskKey: `${sib.taskKey}-1`,
      }),
      routeParams(SLUG, fromTaskId),
    );

    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);

    const audited = await pool.query(
      "select count(*)::int as n from token_audit_log where token_id = $1 and project_id = $2",
      [token.tokenId, sib.projectId],
    );

    expect(audited.rows[0].n).toBeGreaterThan(0);
  });

  // ADR-156: 403-vs-404 on a cross-project target would let an agent probe for
  // project existence platform-wide. Agents get the existence-hidden 404 both
  // when the key resolves elsewhere and when it resolves to nothing.
  it("gives an AGENT token an existence-hidden 404, never the actionable 403", async () => {
    const agentId = "pkg:xproj-probe";

    await pool.query(
      `insert into agents
         (id, package_name, version_label, origin, name, description, workspace,
          mode, triggers, risk_tier, source_path)
       values ($1, 'pkg', 'v1.0.0', 'git', 'probe', 'd', 'none', 'session',
               '["manual"]'::jsonb, 'read_only', '/tmp/a.md')
       on conflict (id) do nothing`,
      [agentId],
    );

    const agentToken = await issueAgentRunToken({
      agentId,
      projectId: fx.projectId,
      runId: randomUUID(),
      db,
    });

    const fromTaskId = await freshFromTask("xproj agent");

    const existing = await POST(
      request("POST", agentToken.secret, {
        kind: "blocks",
        toTaskKey: `${sib.taskKey}-1`,
      }),
      routeParams(SLUG, fromTaskId),
    );
    const missing = await POST(
      request("POST", agentToken.secret, {
        kind: "blocks",
        toTaskKey: "NOSUCHKEY-1",
      }),
      routeParams(SLUG, fromTaskId),
    );

    // Indistinguishable — that is the whole point.
    expect(existing.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await existing.json()).toEqual(await missing.json());
  });

  it("404s when toTaskKey resolves into an ARCHIVED project", async () => {
    const fromTaskId = await freshFromTask("xproj archived");

    const res = await POST(
      request("POST", sib.userToken, {
        kind: "blocks",
        toTaskKey: `${sib.archivedTaskKey}-1`,
      }),
      routeParams(SLUG, fromTaskId),
    );

    expect(res.status).toBe(404);
  });

  it("422s when both or neither target form is supplied", async () => {
    const fromTaskId = await freshFromTask("xproj xor");

    const both = await POST(
      request("POST", fx.fullToken, {
        kind: "blocks",
        toNumber: fx.toNumber,
        toTaskKey: `${sib.taskKey}-1`,
      }),
      routeParams(SLUG, fromTaskId),
    );

    expect(both.status).toBe(422);
    expect(await both.json()).toMatchObject({ code: "CONFIG" });

    const neither = await POST(
      request("POST", fx.fullToken, { kind: "blocks" }),
      routeParams(SLUG, fromTaskId),
    );

    expect(neither.status).toBe(422);
  });

  // D4b: opBodySchema is shared by POST and DELETE, so the missing `requires`
  // kind made orchestrator-minted edges UNREMOVABLE over ext/MCP.
  it("creates AND removes a `requires` edge over ext (the D4b hole)", async () => {
    const fromTaskId = await freshFromTask("xproj requires");

    const created = await POST(
      request("POST", sib.userToken, {
        kind: "requires",
        toTaskKey: `${sib.taskKey}-1`,
      }),
      routeParams(SLUG, fromTaskId),
    );

    expect(created.status).toBe(201);

    const removed = await DELETE(
      request("DELETE", sib.userToken, {
        kind: "requires",
        toTaskKey: `${sib.taskKey}-1`,
      }),
      routeParams(SLUG, fromTaskId),
    );

    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, removed: true });

    const rows = await pool.query(
      "select id from task_relations where from_task_id = $1 and kind = 'requires'",
      [fromTaskId],
    );

    expect(rows.rows).toHaveLength(0);
  });
});
