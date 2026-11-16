import type { SQL } from "drizzle-orm";
import type {
  KnowledgePrincipalIdentity,
  KnowledgeTransaction,
} from "../knowledge-access";
import type { KnowledgePrincipal } from "../knowledge-types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";

import { knowledgeConflictEdges } from "../knowledge-conflict-query";
import { lockKnowledgeReadConsumer } from "../knowledge-disclosure";
import { knowledgeRevisionReadPolicyCte } from "../knowledge-query-policy";

import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainAndBrainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const log = pino({
  name: "knowledge-query-planning-test",
  level: process.env.LOG_LEVEL ?? "info",
});

type QueryPlan = Readonly<{
  JIT?: Readonly<{ Functions: number }>;
  "Execution Time": number;
}>;
let database: StartedPostgresTestDb;
let allowedId: string;
let runId: string;
let agentIdentity: KnowledgePrincipalIdentity;
let userIdentity: KnowledgePrincipalIdentity;
let candidates: SQL;

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "knowledge_query_planning",
    poolMax: 1,
  });
  const project = await seedProjectRow(database.db);
  const inaccessible = await seedProjectRow(database.db);
  const companyId = (
    await database.pool.query<{ id: string }>("SELECT id FROM companies")
  ).rows[0]!.id;

  await database.pool.query("UPDATE projects SET brain_enabled=true");
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES('planning-reader','planning-reader@example.test','viewer','active')",
  );
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'agent','planning-agent','knowledge:read','planning-reader'),($1,'user','planning-reader','knowledge:read','planning-reader')",
    [companyId],
  );
  runId = await seedRun(database.db, { projectId: project.id });
  await database.pool.query(
    'UPDATE runs SET knowledge_access=\'{"schemaVersion":1,"state":"complete","generation":1,"restrictions":[]}\'::jsonb WHERE id=$1',
    [runId],
  );
  const ids = [randomUUID(), randomUUID(), randomUUID()];

  allowedId = ids[1]!;
  for (const [index, id] of ids.entries()) {
    const restrictions =
      index === 2 ? [{ kind: "project", projectId: inaccessible.id }] : [];

    await database.pool.query(
      "INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash,source_restrictions) VALUES($1,$2,'assertion','Planning fixture','Synthetic assertion',0.3,$1,$3::jsonb)",
      [id, companyId, JSON.stringify(restrictions)],
    );
  }
  for (const id of ids.slice(1)) {
    await database.pool.query(
      'INSERT INTO brain_edges(id,company_id,from_ref,to_ref,relation,confidence,claim_state,from_revision,to_revision,claim_actor) VALUES($1,$2,$3::jsonb,$4::jsonb,\'contradicts\',0.5,\'potential_conflict\',1,1,\'{"kind":"user","id":"planning-reader"}\')',
      [
        randomUUID(),
        companyId,
        JSON.stringify({ type: "item", id: ids[0] }),
        JSON.stringify({ type: "item", id }),
      ],
    );
  }
  agentIdentity = {
    kind: "agent",
    actor: {
      kind: "agent",
      id: "planning-agent",
      runId,
      attemptId: randomUUID(),
    },
    projectId: project.id,
    bindingId: randomUUID(),
    canReadBrain: true,
    canWriteBrain: false,
  };
  userIdentity = {
    kind: "user",
    actor: {
      kind: "user",
      id: "planning-reader",
      runId: null,
      attemptId: null,
    },
    user: {
      id: "planning-reader",
      role: "viewer",
      accountStatus: "active",
      mustChangePassword: false,
    },
    boundProjectId: null,
  };
  const edges = knowledgeConflictEdges(ids[0]!, 1);

  candidates = sql`SELECT e.record_id,e.revision FROM (${edges}) e`;
  // Force compilation regardless of table statistics; no wall-clock threshold is part of this regression.
  await database.pool.query("SET jit=on");
  await database.pool.query("SET jit_above_cost=0");
  await database.pool.query("SET jit_inline_above_cost=-1");
  await database.pool.query("SET jit_optimize_above_cost=-1");
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function executePolicy(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  identity: KnowledgePrincipalIdentity,
): Promise<QueryPlan> {
  await lockKnowledgeReadConsumer(tx, principal);
  const policy = knowledgeRevisionReadPolicyCte(identity, candidates);
  const query = sql`${policy} SELECT id FROM knowledge_readable_records ORDER BY id`;
  const result = await tx.execute(query);

  expect(result.rows.map((row) => row.id)).toEqual([allowedId]);
  const explained = await tx.execute(
    sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,
  );
  const plans = explained.rows[0]?.["QUERY PLAN"] as readonly QueryPlan[];
  const plan = plans[0]!;

  log.info(
    {
      principalKind: principal.kind,
      jitFunctions: plan.JIT?.Functions ?? 0,
      executionMs: plan["Execution Time"],
    },
    "FIX native policy query plan inspected on real PostgreSQL",
  );

  return plan;
}

it("native execution admission avoids JIT compilation of source authorization and restores the pooled session after commit", async () => {
  const plan = await database.db.transaction((tx) =>
    executePolicy(
      tx,
      { kind: "execution", runId, nodeAttemptId: null },
      agentIdentity,
    ),
  );

  expect(plan.JIT).toBeUndefined();
  expect(
    (await database.pool.query<{ jit: string }>("SHOW jit")).rows[0]!.jit,
  ).toBe("on");
});

it("human admission applies the same query policy before its early return and restores the pooled session after rollback", async () => {
  const rollback = new Error("Intentional query-policy rollback");
  let plan: QueryPlan | undefined;

  await expect(
    database.db.transaction(async (tx) => {
      plan = await executePolicy(
        tx,
        { kind: "user", userId: "planning-reader" },
        userIdentity,
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(plan).toBeDefined();
  expect(plan!.JIT).toBeUndefined();
  expect(
    (await database.pool.query<{ jit: string }>("SHOW jit")).rows[0]!.jit,
  ).toBe("on");
});
