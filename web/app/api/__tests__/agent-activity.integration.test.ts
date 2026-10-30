import type { AnySchema } from "ajv";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { GET as getDetail } from "@/app/api/projects/[slug]/agents/[agentId]/route";
import { GET as getHistory } from "@/app/api/projects/[slug]/agents/[agentId]/runs/route";
import { GET as getIncidents } from "@/app/api/projects/[slug]/agents/[agentId]/incidents/route";
import { POST as acknowledgeIncidents } from "@/app/api/projects/[slug]/agents/[agentId]/incidents/acknowledge/route";
import { GET as getDefinition } from "@/app/api/projects/[slug]/agents/[agentId]/definition/route";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let actingUserId: string | null = null;
let schemas: Record<string, AnySchema>;
const ajv = new Ajv({ strict: false, validateFormats: false });

vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
}));
vi.mock("@/auth", () => ({
  auth: async () => (actingUserId ? { user: { id: actingUserId } } : null),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_activity_http",
  });
  root = await mkdtemp(join(tmpdir(), "agent-activity-http-"));
  const api = await SwaggerParser.dereference(
    resolve("../docs/api/web.openapi.yaml"),
  );

  schemas = (
    api as unknown as { components: { schemas: Record<string, AnySchema> } }
  ).components.schemas;
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

function contract(name: string, value: unknown): void {
  const validate = ajv.compile(schemas[name]);

  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

it("IT-UX-07 enforces live database grants, shows pinned definitions only, and retains safe history after detach/catalog deletion", async () => {
  const projectId = randomUUID();
  const runId = randomUUID();
  const viewer = randomUUID();
  const member = randomUUID();
  const outsider = randomUUID();
  const install = randomUUID();
  const agentId = "activity:scan";
  const installPath = join(root, "pin");

  await mkdir(join(installPath, "maister-agents"), { recursive: true });
  await writeFile(
    join(installPath, "maister-agents", "scan.md"),
    "---\nname: Pinned scan\ndescription: Inspect\nworkspace: none\nmode: session\ntriggers: [manual]\nrisk_tier: read_only\nconfig:\n  - key: greeting\n    type: string\n    default: pinned\n---\nPINNED PROMPT\n",
  );
  for (const id of [viewer, member, outsider])
    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES ($1,$2,'member','active',false)",
      [id, `${id}@example.test`],
    );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$1,'Activity',$2,'ACTHTTP')",
    [projectId, root],
  );
  for (const [id, role] of [
    [viewer, "viewer"],
    [member, "member"],
  ])
    await database.pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES (gen_random_uuid()::text,$1,$2,$3)",
      [projectId, id, role],
    );
  await database.pool.query(
    "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES ($1,'https://example.test/activity','activity','v1',$2,'{}','digest',$3,'Installed','trusted_by_policy')",
    [install, "a".repeat(40), installPath],
  );
  await database.pool.query(
    "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES ($1,$2,$3,'activity')",
    [randomUUID(), projectId, install],
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES ($1,'activity','v99','git','Newest catalog','Catalog only','none','session','[\"manual\"]','read_only','/private/catalog/newest.md')",
    [agentId],
  );
  await database.pool.query(
    'INSERT INTO agent_project_links(id,project_id,agent_id,config) VALUES ($1,$2,$3,\'{"greeting":"instance"}\')',
    [randomUUID(), projectId, agentId],
  );
  await database.pool.query(
    "INSERT INTO runs(id,project_id,flow_version,run_kind,source_agent_id,status,activity_sort_at,activity_timestamp_provenance) VALUES ($1,$2,'fixture','agent',$3,'Failed',now(),'legacy_estimate')",
    [runId, projectId, agentId],
  );
  const params = {
    params: Promise.resolve({
      slug: projectId,
      agentId: encodeURIComponent(agentId),
    }),
  };
  const request = new NextRequest("http://localhost/api/agent-activity");

  expect((await getDetail(request, params)).status).toBe(401);
  actingUserId = outsider;
  expect((await getDetail(request, params)).status).toBe(403);
  actingUserId = viewer;
  const detail = await getDetail(request, params);
  const value = await detail.json();

  expect(detail.status).toBe(200);
  contract("AgentActivityDetail", value);
  expect(value).toMatchObject({
    agentId,
    canReadDefinition: false,
    canEditSettings: false,
    canRetry: false,
    activity: { retainedRunCount: 1 },
  });
  expect(JSON.stringify(value)).not.toMatch(
    /PINNED PROMPT|repoPath|sourcePath|greeting|sessionId/,
  );
  expect((await getDefinition(request, params)).status).toBe(403);
  expect((await getHistory(request, params)).status).toBe(200);
  expect(
    (
      await getHistory(
        new NextRequest("http://localhost/api/a?limit=101"),
        params,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await getHistory(
        new NextRequest("http://localhost/api/a?status=Failed&status=Running"),
        params,
      )
    ).status,
  ).toBe(400);
  actingUserId = member;
  const definition = await getDefinition(request, params);
  const definitionValue = await definition.json();

  contract("AgentDefinitionView", definitionValue);
  expect(definitionValue).toMatchObject({
    state: "available",
    packageVersion: "v1",
    prompt: "PINNED PROMPT\n",
    configuration: { greeting: "instance" },
  });
  expect(JSON.stringify(definitionValue)).not.toContain(installPath);
  await database.pool.query(
    "UPDATE package_installs SET trust_status='untrusted' WHERE id=$1",
    [install],
  );
  expect(await (await getDefinition(request, params)).json()).toMatchObject({
    state: "unavailable",
    reason: "definition_unavailable",
    prompt: null,
    configuration: null,
  });
  expect((await getHistory(request, params)).status).toBe(200);
  await database.pool.query(
    "UPDATE package_installs SET trust_status='trusted_by_policy' WHERE id=$1",
    [install],
  );
  await database.pool.query(
    "DELETE FROM agent_project_links WHERE project_id=$1",
    [projectId],
  );
  expect(await (await getDefinition(request, params)).json()).toMatchObject({
    state: "unavailable",
    reason: "agent_detached",
    prompt: null,
  });
  await database.pool.query("DELETE FROM agents WHERE id=$1", [agentId]);
  const deleted = await (await getDetail(request, params)).json();

  expect(deleted).toMatchObject({
    attachmentState: "deleted",
    activity: { retainedRunCount: 1 },
    canRetry: false,
  });
  const history = await (await getHistory(request, params)).json();

  expect(history.items).toHaveLength(1);
  contract("AgentHistoryItem", history.items[0]);
  const episodeId = randomUUID();

  await database.pool.query(
    "INSERT INTO agent_incident_episodes(id,project_id,source_agent_id,scope_key,scope_kind,fingerprint,reason_code) VALUES ($1,$2,$3,'unknown','unknown',$4,'execution_failed')",
    [episodeId, projectId, agentId, "a".repeat(64)],
  );
  await database.pool.query(
    "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,original_run_id,channel,observed_at) VALUES ($1,$2,$3,$4,'execution_failure',now())",
    [episodeId, `terminal:${runId}`, "a".repeat(64), runId],
  );
  await database.pool.query("DELETE FROM runs WHERE id=$1", [runId]);
  expect((await getDetail(request, params)).status).toBe(200);
  const incidents = await (await getIncidents(request, params)).json();

  expect(incidents.items).toHaveLength(1);
  contract("AgentIncidentEpisode", incidents.items[0]);
  const ackRequest = () =>
    new NextRequest("http://localhost/api/a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodes: [{ episodeId, attentionRevision: 1 }] }),
    });

  actingUserId = viewer;
  expect((await acknowledgeIncidents(ackRequest(), params)).status).toBe(403);
  actingUserId = member;
  const invalidAck = new NextRequest("http://localhost/api/a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runId,
      episodes: [{ episodeId, attentionRevision: 1 }],
    }),
  });

  expect((await acknowledgeIncidents(invalidAck, params)).status).toBe(400);
  expect(
    await (await acknowledgeIncidents(ackRequest(), params)).json(),
  ).toEqual({ acknowledged: 1 });
  expect(
    (
      await getIncidents(
        new NextRequest("http://localhost/api/a?acknowledged=unknown"),
        params,
      )
    ).status,
  ).toBe(400);
  const foreign = {
    params: Promise.resolve({ slug: projectId, agentId: "activity:unknown" }),
  };

  expect((await getDetail(request, foreign)).status).toBe(404);
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [projectId, member],
  );
  expect((await getHistory(request, params)).status).toBe(403);
});
