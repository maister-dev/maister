// M34 (ADR-089 D8/D9) — ext triage op: verdict + 'triaged' stamp +
// `triage_set` activity in ONE transaction; agent-token identity (polymorphic
// `agent` actor + `agent:<id>` audit label); the fixed agent scope ceiling;
// detach revocation.

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

import {
  issueAgentRunToken,
  revokeAgentProjectTokens,
} from "@/lib/agents/tokens";
import * as schemaModule from "@/lib/db/schema";
import { createTask } from "@/lib/services/tasks";
import { issueToken } from "@/lib/tokens/issue";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let TRIAGE: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/route").POST;
let CREATE_TASK: typeof import("@/app/api/v1/ext/projects/[slug]/tasks/route").POST;

const SLUG = "ext-triage";
const AGENT_ID = "triager";

const fx = {
  projectId: "",
  flowId: "",
  ownerId: "",
  taskId: "",
  runId: "",
  agentToken: "",
  agentTokenId: "",
  userToken: "",
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
    .withDatabase("ext_triage_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();
  fx.flowId = randomUUID();
  fx.ownerId = randomUUID();
  fx.runId = randomUUID();

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
    name: "Ext Triage",
    repoPath: `/tmp/${SLUG}`,
    maisterYamlPath: `/tmp/${SLUG}/maister.yaml`,
    taskKey: "EXT",
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
  await db.insert(schema.platformAcpRunners).values({
    id: "triage-runner",
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    provider: { kind: "anthropic" },
    readinessStatus: "Ready",
  });
  await db.insert(schema.agents).values({
    id: AGENT_ID,
    scope: "platform",
    name: AGENT_ID,
    description: "d",
    workspace: "none",
    mode: "session",
    triggers: ["domain_event"],
    riskTier: "read_only",
    sourcePath: `/tmp/agents/${AGENT_ID}/agent.md`,
  });

  // A flowless simple-intent task — the triager's subject.
  const created = await createTask(
    { title: "simple intent", prompt: "do the thing" },
    { projectId: fx.projectId, actorUserId: fx.ownerId },
    db,
  );

  fx.taskId = created.taskId;

  const agentToken = await issueAgentRunToken({
    agentId: AGENT_ID,
    projectId: fx.projectId,
    runId: fx.runId,
    db,
  });

  fx.agentToken = agentToken.secret;
  fx.agentTokenId = agentToken.tokenId;

  const userToken = await issueToken(
    {
      projectId: fx.projectId,
      name: "user token",
      tokenKind: "user",
      ownerUserId: fx.ownerId,
      scopes: ["tasks:triage", "tasks:create"],
    },
    db,
  );

  fx.userToken = userToken.secret;

  TRIAGE = (
    await import("@/app/api/v1/ext/projects/[slug]/tasks/[taskId]/triage/route")
  ).POST;
  CREATE_TASK = (await import("@/app/api/v1/ext/projects/[slug]/tasks/route"))
    .POST;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("POST /api/v1/ext/.../triage — agent verdict", () => {
  it("applies the verdict, stamps 'triaged', and records the agent-actored activity + audit identity", async () => {
    const res = await TRIAGE(
      request("POST", fx.agentToken, {
        flowId: fx.flowId,
        runnerId: "triage-runner",
        targetBranch: "maister/triage-target",
        promotionMode: "pull_request",
      }),
      routeParams(SLUG, fx.taskId),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, triageStatus: "triaged" });

    const task = await pool.query(
      `SELECT flow_id, runner_id, target_branch, promotion_mode, triage_status
       FROM tasks WHERE id = $1`,
      [fx.taskId],
    );

    expect(task.rows[0]).toMatchObject({
      flow_id: fx.flowId,
      runner_id: "triage-runner",
      target_branch: "maister/triage-target",
      promotion_mode: "pull_request",
      triage_status: "triaged",
    });

    const activity = await pool.query(
      `SELECT actor_type, actor_id, payload FROM task_activity
       WHERE task_id = $1 AND event_kind = 'triage_set'`,
      [fx.taskId],
    );

    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0].actor_type).toBe("agent");
    expect(activity.rows[0].actor_id).toBe(AGENT_ID);
    expect(activity.rows[0].payload.flowId).toBe(fx.flowId);

    const audit = await pool.query(
      `SELECT actor_label, scope_used, result FROM token_audit_log
       WHERE token_id = $1 AND scope_used = 'tasks:triage' AND result = 'ok'`,
      [fx.agentTokenId],
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_label).toBe(`agent:${AGENT_ID}`);
  });

  it("enforces the fixed agent scope ceiling — task creation is outside the set", async () => {
    const res = await CREATE_TASK(
      request("POST", fx.agentToken, { title: "rogue", prompt: "p" }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(res.status).toBe(403);

    const audit = await pool.query(
      `SELECT result, status_code FROM token_audit_log
       WHERE token_id = $1 AND scope_used = 'tasks:create'`,
      [fx.agentTokenId],
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ result: "error", status_code: 403 });
  });

  it("rejects an unknown flowId (422), a bad branch name (422), and an empty body (422)", async () => {
    const unknownFlow = await TRIAGE(
      request("POST", fx.userToken, { flowId: randomUUID() }),
      routeParams(SLUG, fx.taskId),
    );

    expect(unknownFlow.status).toBe(422);

    const badBranch = await TRIAGE(
      request("POST", fx.userToken, { targetBranch: "bad branch~name" }),
      routeParams(SLUG, fx.taskId),
    );

    expect(badBranch.status).toBe(422);

    const empty = await TRIAGE(
      request("POST", fx.userToken, {}),
      routeParams(SLUG, fx.taskId),
    );

    expect(empty.status).toBe(422);
  });

  it("hides cross-project tasks with 404", async () => {
    const res = await TRIAGE(
      request("POST", fx.userToken, { flowId: fx.flowId }),
      routeParams(SLUG, randomUUID()),
    );

    expect(res.status).toBe(404);
  });

  it("detach revocation kills the live agent token (401 afterwards)", async () => {
    const revoked = await revokeAgentProjectTokens({
      agentId: AGENT_ID,
      projectId: fx.projectId,
      db,
    });

    expect(revoked).toBeGreaterThanOrEqual(1);

    const res = await TRIAGE(
      request("POST", fx.agentToken, { flowId: fx.flowId }),
      routeParams(SLUG, fx.taskId),
    );

    expect(res.status).toBe(401);
  });
});
