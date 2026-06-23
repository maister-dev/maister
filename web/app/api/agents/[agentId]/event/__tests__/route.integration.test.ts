// M34 (ADR-089) — inbound webhook trigger route: `agents:trigger` scope, the
// 32 KB payload bound, X-Maister-Trigger-Event-Id validation, launch + the
// partial-unique dedup. Mirrors the ext-route + triggers harnesses.

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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { issueToken } from "@/lib/tokens/issue";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let EVENT: typeof import("@/app/api/agents/[agentId]/event/route").POST;

const SLUG = "ext-webhook";
const AGENT_ID = "test-pkg:notifier";

const fx = { projectId: "", triggerToken: "", noScopeToken: "" };

function request(opts: {
  token: string;
  body?: unknown;
  rawBody?: string;
  eventId?: string;
}): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.token}`,
  };

  if (opts.eventId !== undefined) {
    headers["x-maister-trigger-event-id"] = opts.eventId;
  }

  const body =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;

  return new NextRequest("http://localhost/api/agents/x/event", {
    method: "POST",
    ...(body === undefined ? {} : { body }),
    headers,
  });
}

function routeParams(agentId: string) {
  return { params: Promise.resolve({ agentId }) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_webhook_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();

  // Effective chain: an installed package revision whose dir carries the
  // agent's .md, an Enabled/trusted pinned project flow, a ready default runner.
  const agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-webhook-"));

  await mkdir(path.join(agentsRoot, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(agentsRoot, "maister-agents", "notifier.md"),
    `---
name: notifier
description: d
workspace: none
mode: session
triggers:
  - webhook
risk_tier: read_only
---
Do the thing.
`,
    "utf8",
  );

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', 'WHK')`,
    [fx.projectId, SLUG, `/repos/${fx.projectId}`],
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
    [randomUUID(), fx.projectId, agentsRoot, revisionId],
  );

  // (ADR-106) The package-anchored chain the webhook launch resolves through:
  // an attached, trusted, Installed package_install at agentsRoot.
  const packageInstallId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/test-pkg', 'test-pkg', 'v1.0.0', 'rev-pkg-1',
             '{}'::jsonb, 'digest', $2, 'Installed', 'trusted')`,
    [packageInstallId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, 'test-pkg')`,
    [randomUUID(), fx.projectId, packageInstallId],
  );
  await pool.query(
    `INSERT INTO "platform_acp_runners" ("id", "adapter", "capability_agent", "model", "provider", "readiness_status")
     VALUES ('whk-runner', 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb, 'Ready')`,
  );
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', 'whk-runner')
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = 'whk-runner'`,
  );
  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', 'notifier', 'd', 'none', 'session', '["webhook"]'::jsonb, 'read_only', $2)`,
    [AGENT_ID, path.join(agentsRoot, "maister-agents", "notifier.md")],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), AGENT_ID, fx.projectId],
  );

  const triggerToken = await issueToken(
    {
      projectId: fx.projectId,
      name: "wh",
      tokenKind: "project",
      scopes: ["agents:trigger"],
    },
    db,
  );

  fx.triggerToken = triggerToken.secret;

  const noScope = await issueToken(
    {
      projectId: fx.projectId,
      name: "noscope",
      tokenKind: "project",
      scopes: ["tasks:read"],
    },
    db,
  );

  fx.noScopeToken = noScope.secret;

  EVENT = (await import("@/app/api/agents/[agentId]/event/route")).POST;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("POST /api/agents/[agentId]/event — webhook trigger", () => {
  it("rejects a token without the agents:trigger scope (403)", async () => {
    const res = await EVENT(
      request({ token: fx.noScopeToken, body: {} }),
      routeParams(AGENT_ID),
    );

    expect(res.status).toBe(403);
  });

  it("rejects an oversized payload (413)", async () => {
    const big = JSON.stringify({ blob: "x".repeat(33 * 1024) });
    const res = await EVENT(
      request({ token: fx.triggerToken, rawBody: big }),
      routeParams(AGENT_ID),
    );

    expect(res.status).toBe(413);
  });

  it("rejects a non-object JSON payload (422)", async () => {
    const res = await EVENT(
      request({ token: fx.triggerToken, rawBody: "[1,2,3]" }),
      routeParams(AGENT_ID),
    );

    expect(res.status).toBe(422);
  });

  it("rejects a malformed X-Maister-Trigger-Event-Id (422)", async () => {
    const res = await EVENT(
      request({ token: fx.triggerToken, body: {}, eventId: "not-a-number" }),
      routeParams(AGENT_ID),
    );

    expect(res.status).toBe(422);
  });

  it("launches on a valid webhook (202) and persists trigger_source + payload", async () => {
    const res = await EVENT(
      request({
        token: fx.triggerToken,
        body: { branch: "feature/x" },
        eventId: "8000",
      }),
      routeParams(AGENT_ID),
    );

    expect(res.status).toBe(202);

    const json = (await res.json()) as { runId: string };

    expect(typeof json.runId).toBe("string");

    const row = await pool.query(
      `SELECT trigger_source, trigger_event_id, trigger_payload FROM runs WHERE id = $1`,
      [json.runId],
    );

    expect(row.rows[0].trigger_source).toBe("webhook");
    expect(Number(row.rows[0].trigger_event_id)).toBe(8000);
    expect(row.rows[0].trigger_payload).toMatchObject({ branch: "feature/x" });
  });

  it("dedups a redelivery of the same trigger-event-id (409)", async () => {
    const res = await EVENT(
      request({
        token: fx.triggerToken,
        body: { branch: "feature/x" },
        eventId: "8000",
      }),
      routeParams(AGENT_ID),
    );

    expect(res.status).toBe(409);
  });
});
