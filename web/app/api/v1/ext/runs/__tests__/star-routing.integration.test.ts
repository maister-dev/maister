// M37 Phase 9 (ADR-099): star-routed messaging is a PROPERTY enforced by token
// scoping — a regular agent CHILD token (issueAgentRunToken, AGENT_TOKEN_SCOPES)
// lacks `runs:delegate`, so it CANNOT message OR delegate to any run. Only the
// orchestrator (issueOrchestratorRunToken, ORCHESTRATOR_TOKEN_SCOPES) holds the
// scope. This proves "no mesh — only the orchestrator relays". The 403 is the
// handleExt scope gate; the failure is audited in token_audit_log.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

// Supervisor seam: never reached for a 403, but a spawn would no-op if a later
// scope-passing call slipped through.
const createSessionSpy = vi.fn(
  async (input: { runId: string; resumeSessionId?: string }) => ({
    sessionId: `sup-${input.runId}`,
    pid: 1,
    acpSessionId: input.resumeSessionId ?? `acp-${input.runId}`,
  }),
);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    createSession: (input: unknown) => createSessionSpy(input as never),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    streamSession: async function* () {
      return;
    },
    listSessions: vi.fn(async () => []),
  };
});

let issueAgentRunToken: typeof import("@/lib/agents/tokens").issueAgentRunToken;
let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let messagePost: typeof import("@/app/api/v1/ext/runs/message/route").POST;
let delegatePost: typeof import("@/app/api/v1/ext/runs/delegate/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-star-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_star_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ issueAgentRunToken, issueOrchestratorRunToken } = await import(
    "@/lib/agents/tokens"
  ));
  ({ POST: messagePost } = await import("@/app/api/v1/ext/runs/message/route"));
  ({ POST: delegatePost } = await import(
    "@/app/api/v1/ext/runs/delegate/route"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;

beforeEach(async () => {
  createSessionSpy.mockClear();

  await pool.query(`DELETE FROM "token_audit_log"`);
  await pool.query(`DELETE FROM "project_tokens"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );

  const revisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', 'rev-1',
             'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [revisionId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', $3,
             '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), projectId, agentsRoot, revisionId],
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

async function seedAgent(id: string): Promise<string> {
  const qualifiedId = `test-pkg:${id}`;

  await mkdir(path.join(agentsRoot, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(agentsRoot, "maister-agents", `${id}.md`),
    `---
name: ${id}
description: d
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
Do the thing.
`,
    "utf8",
  );

  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $3, true)`,
    [qualifiedId, id, path.join(agentsRoot, "maister-agents", `${id}.md`)],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

// A child run (run_kind=agent) under an orchestrator tree, plus a regular agent
// ephemeral token (AGENT_TOKEN_SCOPES — NO runs:delegate).
async function seedChildWithAgentToken(
  agentId: string,
): Promise<{ runId: string; secret: string }> {
  const rootRunId = randomUUID();
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id",
       "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $1,
             '{"capabilityAgent":"claude"}'::jsonb, $4)`,
    [rootRunId, agentId, projectId, executorId],
  );
  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $4, $4,
             '{"capabilityAgent":"claude"}'::jsonb, $5)`,
    [runId, agentId, projectId, rootRunId, executorId],
  );

  const { secret } = await issueAgentRunToken({
    agentId,
    projectId,
    runId,
    db,
  });

  return { runId, secret };
}

async function seedOrchestratorRun(
  agentId: string,
): Promise<{ runId: string; secret: string }> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id",
       "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $1,
             '{"capabilityAgent":"claude"}'::jsonb, $4)`,
    [runId, agentId, projectId, executorId],
  );

  const { secret } = await issueOrchestratorRunToken({ projectId, runId, db });

  return { runId, secret };
}

function jsonReq(url: string, secret: string, body: unknown): NextRequest {
  const req = new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

const MSG_URL = "http://localhost/api/v1/ext/runs/message";
const DEL_URL = "http://localhost/api/v1/ext/runs/delegate";

async function auditRowsFor(
  endpoint: string,
): Promise<Array<{ result: string; status_code: number; scope_used: string }>> {
  const res = await pool.query(
    `SELECT "result", "status_code", "scope_used" FROM "token_audit_log" WHERE "endpoint" = $1`,
    [endpoint],
  );

  return res.rows;
}

describe("M37 Phase 9 — star-routed messaging (no mesh)", () => {
  it("a regular agent CHILD token cannot message another run → 403 + audited", async () => {
    const worker = await seedAgent("worker-agent");
    const { secret } = await seedChildWithAgentToken(worker);

    const res = await messagePost(
      jsonReq(MSG_URL, secret, {
        addressableKey: "sibling",
        prompt: "child should not be able to relay",
      }),
      {},
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("UNAUTHORIZED");
    expect(createSessionSpy).not.toHaveBeenCalled();

    const audit = await auditRowsFor("POST /api/v1/ext/runs/message");

    expect(audit).toHaveLength(1);
    expect(audit[0].result).toBe("error");
    expect(audit[0].status_code).toBe(403);
    expect(audit[0].scope_used).toBe("runs:delegate");
  });

  it("a regular agent CHILD token cannot delegate → 403 + audited", async () => {
    const worker = await seedAgent("worker-agent");
    const { secret } = await seedChildWithAgentToken(worker);

    const res = await delegatePost(
      jsonReq(DEL_URL, secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "child should not be able to delegate",
      }),
      {},
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("UNAUTHORIZED");
    expect(createSessionSpy).not.toHaveBeenCalled();

    const audit = await auditRowsFor("POST /api/v1/ext/runs/delegate");

    expect(audit).toHaveLength(1);
    expect(audit[0].result).toBe("error");
    expect(audit[0].status_code).toBe(403);
    expect(audit[0].scope_used).toBe("runs:delegate");
  });

  it("an ORCHESTRATOR token passes the scope gate (delegate is NOT 403)", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker-agent");
    const { secret } = await seedOrchestratorRun(orchestrator);

    const res = await delegatePost(
      jsonReq(DEL_URL, secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "orchestrator may delegate",
      }),
      {},
    );

    // It clears the scope gate — it may succeed (202) or fail downstream, but
    // NEVER 403 (insufficient scope).
    expect(res.status).not.toBe(403);
  });
});
