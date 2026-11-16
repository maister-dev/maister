import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { generateToken } from "@/lib/tokens/secret";
import { verifyToken } from "@/lib/tokens/verify";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
let before: Readonly<Record<string, unknown>>[];
const userId = randomUUID();
const agentId = "migration:token-observer";
const credentials: { secret: string; kind: "project" | "agent" | "user" }[] =
  [];

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_agent_credentials_upgrade" },
    "0240_company_agent_execution",
  );
  projectId = (await seedProjectRow(database.db)).id;
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES($1,'migration','legacy','git','Token observer','Retained project credential','none','session','[\"manual\"]','read_only','/retained/observer.md')",
    [agentId],
  );
  for (const kind of ["project", "agent", "user"] as const) {
    const token = generateToken();

    credentials.push({ secret: token.secret, kind });
    await database.pool.query(
      "INSERT INTO project_tokens(id,project_id,name,token_kind,owner_user_id,agent_id,prefix,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[\"knowledge:read\"]'::jsonb,now()+interval '1 hour')",
      [
        randomUUID(),
        kind === "user" ? null : projectId,
        kind === "agent" ? `agent-run:${randomUUID()}` : `retained-${kind}`,
        kind,
        kind === "user" ? userId : null,
        kind === "agent" ? agentId : null,
        token.prefix,
        token.hash,
      ],
    );
  }
  before = (
    await database.pool.query(
      "SELECT to_jsonb(t) AS value FROM project_tokens t ORDER BY id",
    )
  ).rows.map((row: { value: Record<string, unknown> }) => row.value);
  await applyMainMigration(database.db, "0241_company_agent_credentials");
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("preserves existing project, user and agent token hashes, bindings and verification without inferred company ownership", async () => {
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(t) AS value FROM project_tokens t ORDER BY id",
      )
    ).rows.map((row: { value: Record<string, unknown> }) => row.value),
  ).toEqual(
    before.map((row) => ({ ...row, company_id: null, company_run_id: null })),
  );
  for (const credential of credentials) {
    const actor = await verifyToken(credential.secret, database.db);

    expect(actor.tokenKind).toBe(credential.kind);
    expect(actor.projectId).toBe(credential.kind === "user" ? null : projectId);
    expect(actor).not.toHaveProperty("companyId");
  }
});

it("keeps ordinary project credential cascade cleanup and personal user credentials independent of Brain", async () => {
  await database.pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
  expect(
    (
      await database.pool.query(
        "SELECT token_kind,company_id,company_run_id FROM project_tokens",
      )
    ).rows,
  ).toEqual([{ token_kind: "user", company_id: null, company_run_id: null }]);
});
