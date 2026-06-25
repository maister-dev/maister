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
  disabledFlowId: "",
  ownerId: "",
  taskId: "",
  runId: "",
  agentToken: "",
  agentTokenId: "",
  userToken: "",
  userTokenId: "",
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
  // ADR-111 (D9): a verdict flow must be launchable NOW (enablement + trust) —
  // a verdict on a non-launchable flow is refused at triage time (no silent
  // stall). Seed this fixture flow launchable so the verdict-success cases hold.
  await db.insert(schema.flows).values({
    id: fx.flowId,
    projectId: fx.projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });
  // A second flow that is NOT launchable (default Installed + untrusted) — the
  // D9 write-side regression target.
  fx.disabledFlowId = randomUUID();
  await db.insert(schema.flows).values({
    id: fx.disabledFlowId,
    projectId: fx.projectId,
    flowRefId: "disabled-flow",
    source: "github.com/x/z",
    version: "v1.0.0",
    installedPath: "/tmp/flows/disabled",
    manifest: { schemaVersion: 1, name: "Disabled", steps: [] },
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
    packageName: "test-pkg",
    versionLabel: "v1.0.0",
    origin: "git",
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
  fx.userTokenId = userToken.tokenId;

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

// ADR-111 — the triage `flag` op: mark `flagged` (held), NO verdict columns,
// in the SAME transaction as the token audit; mutually exclusive with verdict
// fields (422 CONFIG). Uses the user token (the agent token is revoked above).
describe("POST /api/v1/ext/.../triage — flag op (ADR-111)", () => {
  async function freshTask(): Promise<string> {
    const created = await createTask(
      { title: "to flag", prompt: "maybe a dup" },
      { projectId: fx.projectId, actorUserId: fx.ownerId },
      db,
    );

    return created.taskId;
  }

  it("flag: true → 'flagged', writes NO verdict columns, one-tx + audit row", async () => {
    const taskId = await freshTask();

    const res = await TRIAGE(
      request("POST", fx.userToken, { flag: true }),
      routeParams(SLUG, taskId),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, triageStatus: "flagged" });

    const task = await pool.query(
      `SELECT triage_status, flow_id, runner_id, target_branch, promotion_mode
       FROM tasks WHERE id = $1`,
      [taskId],
    );

    expect(task.rows[0]).toMatchObject({
      triage_status: "flagged",
      flow_id: null,
      runner_id: null,
      target_branch: null,
      promotion_mode: null,
    });

    // Activity recorded with the flag marker (reuses the triage_set kind).
    const activity = await pool.query(
      `SELECT payload FROM task_activity
       WHERE task_id = $1 AND event_kind = 'triage_set'`,
      [taskId],
    );

    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0].payload).toMatchObject({ flag: true });

    // Token audit row committed in the same transaction as the flag.
    const audit = await pool.query(
      `SELECT result, status_code FROM token_audit_log
       WHERE token_id = $1 AND scope_used = 'tasks:triage'
         AND result = 'ok' AND status_code = 200`,
      [fx.userTokenId],
    );

    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("flag + a verdict field together → 422 CONFIG (mutually exclusive), task unchanged", async () => {
    const taskId = await freshTask();

    const res = await TRIAGE(
      request("POST", fx.userToken, { flag: true, flowId: fx.flowId }),
      routeParams(SLUG, taskId),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "CONFIG" });

    // Neither the verdict nor the flag landed.
    const task = await pool.query(
      `SELECT triage_status, flow_id FROM tasks WHERE id = $1`,
      [taskId],
    );

    expect(task.rows[0]).toMatchObject({
      triage_status: null,
      flow_id: null,
    });
  });

  it("flag: true alone satisfies the ≥1-field rule (empty body still 422)", async () => {
    const taskId = await freshTask();

    const empty = await TRIAGE(
      request("POST", fx.userToken, {}),
      routeParams(SLUG, taskId),
    );

    expect(empty.status).toBe(422);
  });
});

// ADR-111 (Phase 4) — the triage `enqueue` intent + the D9 no-silent-stall
// write-side validation.
describe("POST /api/v1/ext/.../triage — enqueue + D9 (ADR-111)", () => {
  async function freshTask(): Promise<string> {
    const created = await createTask(
      { title: "to enqueue", prompt: "route it" },
      { projectId: fx.projectId, actorUserId: fx.ownerId },
      db,
    );

    return created.taskId;
  }

  it("verdict + enqueue → triaged + launch_mode='auto' in ONE transaction", async () => {
    const taskId = await freshTask();

    const res = await TRIAGE(
      request("POST", fx.userToken, { flowId: fx.flowId, enqueue: true }),
      routeParams(SLUG, taskId),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, triageStatus: "triaged" });

    const task = await pool.query(
      `SELECT triage_status, flow_id, launch_mode FROM tasks WHERE id = $1`,
      [taskId],
    );

    expect(task.rows[0]).toMatchObject({
      triage_status: "triaged",
      flow_id: fx.flowId,
      launch_mode: "auto",
    });

    // The enqueue marker rides the triage_set activity payload.
    const activity = await pool.query(
      `SELECT payload FROM task_activity
       WHERE task_id = $1 AND event_kind = 'triage_set'`,
      [taskId],
    );

    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0].payload).toMatchObject({ enqueue: true });
  });

  it("enqueue without a flowId → 422 CONFIG (no silent auto-mode write)", async () => {
    const taskId = await freshTask();

    const res = await TRIAGE(
      request("POST", fx.userToken, {
        runnerId: "triage-runner",
        enqueue: true,
      }),
      routeParams(SLUG, taskId),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "CONFIG" });

    const task = await pool.query(
      `SELECT triage_status, launch_mode FROM tasks WHERE id = $1`,
      [taskId],
    );

    expect(task.rows[0]).toMatchObject({
      triage_status: null,
      launch_mode: null,
    });
  });

  it("verdict on a disabled/untrusted flow → 422 CONFIG (D9 write side, no stall)", async () => {
    const taskId = await freshTask();

    const res = await TRIAGE(
      request("POST", fx.userToken, { flowId: fx.disabledFlowId }),
      routeParams(SLUG, taskId),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "CONFIG" });

    const task = await pool.query(
      `SELECT triage_status, flow_id FROM tasks WHERE id = $1`,
      [taskId],
    );

    expect(task.rows[0]).toMatchObject({
      triage_status: null,
      flow_id: null,
    });
  });

  it("verdict WITHOUT enqueue clears a prior launch_mode='auto' (triage_set is authoritative)", async () => {
    const taskId = await freshTask();

    // Arm auto via enqueue.
    await TRIAGE(
      request("POST", fx.userToken, { flowId: fx.flowId, enqueue: true }),
      routeParams(SLUG, taskId),
    );

    expect(
      (
        await pool.query(`SELECT launch_mode FROM tasks WHERE id = $1`, [
          taskId,
        ])
      ).rows[0].launch_mode,
    ).toBe("auto");

    // Re-triage WITHOUT enqueue — must CLEAR the stale arm, not inherit it,
    // otherwise the tick would auto-launch work this verdict did not authorize.
    const res = await TRIAGE(
      request("POST", fx.userToken, { runnerId: "triage-runner" }),
      routeParams(SLUG, taskId),
    );

    expect(res.status).toBe(200);

    const task = await pool.query(
      `SELECT triage_status, launch_mode FROM tasks WHERE id = $1`,
      [taskId],
    );

    expect(task.rows[0]).toMatchObject({
      triage_status: "triaged",
      launch_mode: null,
    });
  });

  it("flag clears a prior launch_mode='auto' (a held task carries no enqueue intent)", async () => {
    const taskId = await freshTask();

    await TRIAGE(
      request("POST", fx.userToken, { flowId: fx.flowId, enqueue: true }),
      routeParams(SLUG, taskId),
    );

    const res = await TRIAGE(
      request("POST", fx.userToken, { flag: true }),
      routeParams(SLUG, taskId),
    );

    expect(res.status).toBe(200);

    const task = await pool.query(
      `SELECT triage_status, launch_mode FROM tasks WHERE id = $1`,
      [taskId],
    );

    expect(task.rows[0]).toMatchObject({
      triage_status: "flagged",
      launch_mode: null,
    });
  });

  it("enqueue on a task with an EXISTING flow (no body flowId) arms it — OpenAPI resolvable-flow", async () => {
    const taskId = await freshTask();

    // Give the task a flow via a verdict (no enqueue) so it has an existing flow.
    await TRIAGE(
      request("POST", fx.userToken, { flowId: fx.flowId }),
      routeParams(SLUG, taskId),
    );

    expect(
      (
        await pool.query(`SELECT launch_mode FROM tasks WHERE id = $1`, [
          taskId,
        ])
      ).rows[0].launch_mode,
    ).toBeNull();

    // Enqueue with NO body flowId — the task's existing flow_id makes it
    // resolvable (OpenAPI), so this must ARM (200), not 422 as before the fix.
    const res = await TRIAGE(
      request("POST", fx.userToken, { enqueue: true }),
      routeParams(SLUG, taskId),
    );

    expect(res.status).toBe(200);

    const task = await pool.query(
      `SELECT triage_status, flow_id, launch_mode, launch_armed_at
       FROM tasks WHERE id = $1`,
      [taskId],
    );

    expect(task.rows[0]).toMatchObject({
      triage_status: "triaged",
      flow_id: fx.flowId,
      launch_mode: "auto",
    });
    expect(task.rows[0].launch_armed_at).not.toBeNull();
  });
});
