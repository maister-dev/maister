// M37 Phase 8 (ADR-099): the run_message ext surface — re-message resolution +
// scoping + respawn, persistent uniqueness, and persistent-requires-key. The
// supervisor seam is mocked (createSession spy + an immediately-ending stream)
// so the parked-child respawn fires startAgentSession against the mock without a
// real adapter.

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

// Supervisor seam: createSession returns a fake handle (spied so test 2 can
// assert the resumeSessionId), sendPrompt is a no-op, and streamSession yields
// nothing then ends so consumeAgentSession detaches without a terminal flip.
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

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let messagePost: typeof import("@/app/api/v1/ext/runs/message/route").POST;
let delegatePost: typeof import("@/app/api/v1/ext/runs/delegate/route").POST;
let sendAgentMessage: typeof import("@/lib/agents/launch").sendAgentMessage;

type AgentSupervisorApi = import("@/lib/agents/launch").AgentSupervisorApi;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-msg-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_message_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: messagePost } = await import("@/app/api/v1/ext/runs/message/route"));
  ({ POST: delegatePost } = await import(
    "@/app/api/v1/ext/runs/delegate/route"
  ));
  ({ sendAgentMessage } = await import("@/lib/agents/launch"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;

beforeEach(async () => {
  createSessionSpy.mockClear();

  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "task_relations"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "project_tokens"`);
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
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $3, true)`,
    [qualifiedId, id, path.join(agentsRoot, "maister-agents", `${id}.md`)],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

// Orchestrator parent run (run_kind=agent, its own tree root) + run-bound token.
async function seedOrchestratorRun(
  orchestratorAgentId: string,
): Promise<{ runId: string; secret: string }> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id",
       "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $1,
             '{"capabilityAgent":"claude"}'::jsonb, $4)`,
    [runId, orchestratorAgentId, projectId, executorId],
  );

  const { secret } = await issueOrchestratorRunToken({ projectId, runId, db });

  return { runId, secret };
}

// A parked persistent child (NeedsInputIdle) with a retained acp handle.
async function seedParkedChild(args: {
  agentId: string;
  rootRunId: string;
  parentRunId: string;
  addressableKey: string;
  acpSessionId?: string;
}): Promise<string> {
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "persistent", "addressable_key", "acp_session_id", "checkpoint_at",
       "agent_workspace", "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, 'NeedsInputIdle', 'agent', 'manual', $4, $5,
             true, $6, $7, now(), 'none', '{"capabilityAgent":"claude"}'::jsonb, $8)`,
    [
      childRunId,
      args.agentId,
      projectId,
      args.parentRunId,
      args.rootRunId,
      args.addressableKey,
      args.acpSessionId ?? `acp-${childRunId}`,
      executorId,
    ],
  );

  return childRunId;
}

// A LIVE persistent child (Running) — exercises sendAgentMessage's live-delivery
// branch (acp_session_id may be null to hit the "no live handle" precondition).
async function seedRunningChild(args: {
  agentId: string;
  parentRunId: string;
  rootRunId: string;
  addressableKey: string;
  acpSessionId: string | null;
}): Promise<string> {
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "persistent", "addressable_key", "acp_session_id", "agent_workspace",
       "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $4, $5,
             true, $6, $7, 'none', '{"capabilityAgent":"claude"}'::jsonb, $8)`,
    [
      childRunId,
      args.agentId,
      projectId,
      args.parentRunId,
      args.rootRunId,
      args.addressableKey,
      args.acpSessionId,
      executorId,
    ],
  );

  return childRunId;
}

// A fake supervisor API whose sendPrompt is a spy (the live branch only delivers).
function fakeSupervisorApi(): {
  api: AgentSupervisorApi;
  sendPrompt: ReturnType<typeof vi.fn>;
} {
  const sendPrompt = vi.fn(async () => ({ stopReason: "end_turn" as const }));

  return {
    api: {
      createSession: vi.fn(),
      deliverPermission: vi.fn(),
      sendPrompt,
      streamSession: async function* () {},
    } as unknown as AgentSupervisorApi,
    sendPrompt,
  };
}

function jsonReq(
  url: string,
  secret: string | null,
  body: unknown,
): NextRequest {
  const req = new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (secret) req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

const MSG_URL = "http://localhost/api/v1/ext/runs/message";
const DEL_URL = "http://localhost/api/v1/ext/runs/delegate";

describe("POST /api/v1/ext/runs/message (M37 Phase 8)", () => {
  it("(2) re-messages a parked child by key → respawn with resumeSessionId, status Running", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("reviewer-agent");
    const { runId: rootRunId, secret } =
      await seedOrchestratorRun(orchestrator);
    const childRunId = await seedParkedChild({
      agentId: worker,
      rootRunId,
      parentRunId: rootRunId,
      addressableKey: "reviewer",
      acpSessionId: "acp-reviewer-1",
    });

    const res = await messagePost(
      jsonReq(MSG_URL, secret, {
        addressableKey: "reviewer",
        prompt: "re-review the latest diff",
      }),
      {},
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { childRunId: string; status: string };

    expect(json.childRunId).toBe(childRunId);
    expect(json.status).toBe("Running");

    // The child was claimed NeedsInputIdle → Running.
    const row = await pool.query(
      `SELECT "status" FROM "runs" WHERE "id" = $1`,
      [childRunId],
    );

    expect(row.rows[0].status).toBe("Running");

    // Respawn fired with the retained acp handle as resumeSessionId.
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    expect(createSessionSpy.mock.calls[0][0]).toMatchObject({
      runId: childRunId,
      resumeSessionId: "acp-reviewer-1",
    });
  });

  it("(2b) a key in ANOTHER tree → PRECONDITION, no delivery", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("reviewer-agent");

    // The caller's own tree.
    const { secret } = await seedOrchestratorRun(orchestrator);

    // A DIFFERENT tree with a persistent child keyed 'reviewer'.
    const { runId: otherRoot } = await seedOrchestratorRun(orchestrator);

    await seedParkedChild({
      agentId: worker,
      rootRunId: otherRoot,
      parentRunId: otherRoot,
      addressableKey: "reviewer",
    });

    const res = await messagePost(
      jsonReq(MSG_URL, secret, {
        addressableKey: "reviewer",
        prompt: "should not reach the other tree",
      }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it("(3) two persistent delegations with the same key in one tree → 2nd is CONFLICT", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("reviewer-agent");
    const { secret } = await seedOrchestratorRun(orchestrator);

    const first = await delegatePost(
      jsonReq(DEL_URL, secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "first persistent child",
        persistent: true,
        addressableKey: "reviewer",
      }),
      {},
    );

    expect(first.status).toBe(202);

    const second = await delegatePost(
      jsonReq(DEL_URL, secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "duplicate key",
        persistent: true,
        addressableKey: "reviewer",
      }),
      {},
    );

    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("CONFLICT");

    // Exactly one persistent child with that key in the tree.
    const cnt = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "persistent" = true AND "addressable_key" = 'reviewer'`,
    );

    expect(cnt.rows[0].n).toBe(1);
  });

  it("(3b) the same key in DIFFERENT trees → both ok", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("reviewer-agent");
    const { secret: secretA } = await seedOrchestratorRun(orchestrator);
    const { secret: secretB } = await seedOrchestratorRun(orchestrator);

    const a = await delegatePost(
      jsonReq(DEL_URL, secretA, {
        target: { agentId: worker },
        mode: "run",
        prompt: "tree A child",
        persistent: true,
        addressableKey: "reviewer",
      }),
      {},
    );
    const b = await delegatePost(
      jsonReq(DEL_URL, secretB, {
        target: { agentId: worker },
        mode: "run",
        prompt: "tree B child",
        persistent: true,
        addressableKey: "reviewer",
      }),
      {},
    );

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
  });

  it("(4) delegate persistent=true with no addressableKey → CONFIG, no child", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("reviewer-agent");
    const { secret } = await seedOrchestratorRun(orchestrator);

    const before = await pool.query(`SELECT count(*)::int AS n FROM "runs"`);

    const res = await delegatePost(
      jsonReq(DEL_URL, secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "persistent without a key",
        persistent: true,
      }),
      {},
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");

    const after = await pool.query(`SELECT count(*)::int AS n FROM "runs"`);

    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  // sendAgentMessage's LIVE branch: a Running child gets the prompt delivered to
  // its already-attached supervisor session. Driven directly (the route does not
  // inject listSessions/api) so the delivery is observable.
  it("(5) re-messages a LIVE (Running) child → delivers the prompt to its session", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("reviewer-agent");
    const { runId: rootRunId } = await seedOrchestratorRun(orchestrator);
    const childRunId = await seedRunningChild({
      agentId: worker,
      parentRunId: rootRunId,
      rootRunId,
      addressableKey: "live",
      acpSessionId: "acp-live-child",
    });

    const { api, sendPrompt } = fakeSupervisorApi();
    const listLive: typeof import("@/lib/supervisor-client").listSessions =
      async () =>
        [
          {
            sessionId: "sup-live",
            status: "live",
            acpSessionId: "acp-live-child",
          },
        ] as never;

    const result = await sendAgentMessage(childRunId, "keep going", {
      db,
      api,
      listSessions: listLive,
    });

    expect(result).toEqual({ childRunId, status: "Running" });
    expect(sendPrompt).toHaveBeenCalledWith("sup-live", {
      stepId: "agent",
      prompt: "keep going",
    });
  });

  it("a Running child with NO acp handle yet → PRECONDITION (no delivery)", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("reviewer-agent");
    const { runId: rootRunId } = await seedOrchestratorRun(orchestrator);
    const childRunId = await seedRunningChild({
      agentId: worker,
      parentRunId: rootRunId,
      rootRunId,
      addressableKey: "live",
      acpSessionId: null,
    });

    const { api, sendPrompt } = fakeSupervisorApi();

    await expect(
      sendAgentMessage(childRunId, "x", {
        db,
        api,
        listSessions: async () => [] as never,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("a Running child whose session is no longer live → PRECONDITION (no delivery)", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("reviewer-agent");
    const { runId: rootRunId } = await seedOrchestratorRun(orchestrator);
    const childRunId = await seedRunningChild({
      agentId: worker,
      parentRunId: rootRunId,
      rootRunId,
      addressableKey: "live",
      acpSessionId: "acp-gone",
    });

    const { api, sendPrompt } = fakeSupervisorApi();

    await expect(
      sendAgentMessage(childRunId, "x", {
        db,
        api,
        // No session matches acp-gone → no live supervisor session.
        listSessions: async () => [] as never,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
