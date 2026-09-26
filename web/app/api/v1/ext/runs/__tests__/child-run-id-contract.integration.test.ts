// The five child-run operations share ONE `childRunId` contract with the
// external OpenAPI: `format: uuid` (run ids are minted with randomUUID). A
// malformed id is a body-schema refusal — 422 CONFIG — never a lookup that
// answers "no such child" with 409. Auth still runs first: a caller that is
// unauthenticated or lacks the route's scope is refused before the body is
// read, so the malformed body never surfaces as a 422.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

type ExtPost = (req: NextRequest, routeCtx: object) => Promise<Response>;

const MALFORMED = "not-a-uuid";

const ROUTES = [
  { op: "message", body: { childRunId: MALFORMED, prompt: "follow up" } },
  { op: "collect", body: { childRunId: MALFORMED } },
  { op: "cancel", body: { childRunId: MALFORMED } },
  { op: "promote", body: { childRunId: MALFORMED } },
  { op: "rework", body: { childRunId: MALFORMED, prompt: "rework it" } },
] as const;

const posts = new Map<string, ExtPost>();
let orchestratorSecret: string;
let childAgentSecret: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_child_run_id_test",
  });

  pool = testDatabase.pool;
  db = testDatabase.db;

  const { issueAgentRunToken, issueOrchestratorRunToken } = await import(
    "@/lib/agents/tokens"
  );

  posts.set(
    "message",
    (await import("@/app/api/v1/ext/runs/message/route")).POST,
  );
  posts.set(
    "collect",
    (await import("@/app/api/v1/ext/runs/collect/route")).POST,
  );
  posts.set(
    "cancel",
    (await import("@/app/api/v1/ext/runs/cancel/route")).POST,
  );
  posts.set(
    "promote",
    (await import("@/app/api/v1/ext/runs/promote/route")).POST,
  );
  posts.set(
    "rework",
    (await import("@/app/api/v1/ext/runs/rework/route")).POST,
  );

  const projectId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', 'KCHILDID', 1)`,
    [projectId, `p-${projectId.slice(0, 8)}`, `/repos/${projectId}`],
  );

  for (const name of ["orchestrator", "worker"]) {
    await pool.query(
      `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
       VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/agent.md', true)`,
      [`test-pkg:${name}`, name],
    );
  }

  // A live orchestrator and one real child, so the only thing wrong with each
  // request is the id itself.
  const orchestratorRunId = randomUUID();
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id")
     VALUES ($1, 'agent', 'test-pkg:orchestrator', $2, 'Running', 'agent', 'manual', $1)`,
    [orchestratorRunId, projectId],
  );
  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, 'Running', 'agent', 'manual', $3, $3)`,
    [childRunId, projectId, orchestratorRunId],
  );

  ({ secret: orchestratorSecret } = await issueOrchestratorRunToken({
    projectId,
    runId: orchestratorRunId,
    db,
  }));
  ({ secret: childAgentSecret } = await issueAgentRunToken({
    agentId: "test-pkg:worker",
    projectId,
    runId: childRunId,
    db,
  }));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function jsonReq(
  op: string,
  authorization: string | null,
  body: unknown,
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (authorization !== null) headers.authorization = authorization;

  return new NextRequest(`http://localhost/api/v1/ext/runs/${op}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe.each(ROUTES)(
  "POST /api/v1/ext/runs/$op — childRunId",
  ({ op, body }) => {
    it("refuses a malformed childRunId 422 CONFIG, naming the field", async () => {
      const res = await posts.get(op)!(
        jsonReq(op, `Bearer ${orchestratorSecret}`, body),
        {},
      );

      expect(res.status).toBe(422);

      const json = (await res.json()) as { code: string; message: string };

      expect(json.code).toBe("CONFIG");
      expect(json.message).toMatch(/childRunId/);
      expect(json.message).toMatch(/uuid/i);
    });

    it("an unauthenticated malformed body is refused 401, never 422", async () => {
      const res = await posts.get(op)!(
        jsonReq(op, "Bearer not-a-real-token", body),
        {},
      );

      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe(
        "UNAUTHENTICATED",
      );
    });

    it("a token without the route's scope is refused 403 for a malformed body, never 422", async () => {
      const res = await posts.get(op)!(
        jsonReq(op, `Bearer ${childAgentSecret}`, body),
        {},
      );

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(
        "UNAUTHORIZED",
      );
    });
  },
);
