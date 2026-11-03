import { createHash, randomUUID } from "node:crypto";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { canonicalCommandJson } from "../../../../runtime/command-json";

import {
  seedLocalHost,
  seedProjectRow,
  seedRun,
} from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let populated: StartedPostgresTestDb;
let fresh: StartedPostgresTestDb;
let historicalId: string;
let historicalUnknownId: string;
let historical: unknown;

async function commandFixture(
  database: StartedPostgresTestDb,
  owner: Readonly<Record<string, string | number>>,
  operationKey: string,
  continuation?: unknown,
): Promise<string> {
  const project = await seedProjectRow(database.db);
  const runId = await seedRun(database.db, {
    projectId: project.id,
    runKind: "agent",
    status: "Running",
  });
  const existingHost = await database.pool.query<{
    id: string;
    hostKey: string;
  }>(
    'SELECT id,host_key AS "hostKey" FROM execution_hosts WHERE retired_at IS NULL LIMIT 1',
  );
  const host = existingHost.rows[0] ?? (await seedLocalHost(database.db));
  const assignmentId = randomUUID();
  const id = randomUUID();

  await database.pool.query(
    "INSERT INTO execution_assignments(id,run_id,execution_host_id,epoch,state,placement_reason) VALUES($1,$2,$3,1,'active','launch')",
    [assignmentId, runId, host.id],
  );
  await database.pool.query(
    "UPDATE runs SET execution_assignment_id=$2 WHERE id=$1",
    [runId, assignmentId],
  );
  const envelope = {
    command: { id, kind: "session.create", issuedAt: new Date().toISOString() },
    fence: { hostKey: host.hostKey, runId, assignmentId, assignmentEpoch: 1 },
    payload: { stepId: "agent" },
  };
  const requestCanonicalJson = canonicalCommandJson(envelope);
  const intent = {
    version: 1,
    owner,
    operationKey,
    generation: 0,
    supersedesCommandId: null,
    sessionFallback: false,
    requestCanonicalJson,
    requestSha256: createHash("sha256")
      .update(requestCanonicalJson)
      .digest("hex"),
    ...(continuation === undefined ? {} : { continuation }),
  };

  await database.pool.query(
    "INSERT INTO execution_commands(id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,state,payload,max_attempts,create_intent) VALUES($1,$2,$3,$4,1,'session.create','queued','{}'::jsonb,3,$5::jsonb)",
    [id, runId, assignmentId, host.id, JSON.stringify(intent)],
  );

  return id;
}

beforeAll(async () => {
  populated = await startMainPostgresTestDbUpTo(
    { databaseName: "create_owner_populated" },
    "0225_task_launch_agent_preparation",
  );
  // This cutoff already enforces the current writer deployment capability.
  await populated.pool.query("SET maister.task_launch_writer='v3'");
  historicalId = await commandFixture(
    populated,
    { variant: "agent", turnId: "retained-agent-turn", promptOrdinal: 0 },
    "agent-create:retained-agent-turn:0",
  );
  historical = (
    await populated.pool.query(
      "SELECT to_jsonb(c) AS value FROM execution_commands c WHERE id=$1",
      [historicalId],
    )
  ).rows[0].value;
  historicalUnknownId = randomUUID();
  await populated.pool.query(
    "INSERT INTO execution_commands(id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,state,payload,max_attempts) SELECT $1,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,state,payload,max_attempts FROM execution_commands WHERE id=$2",
    [historicalUnknownId, historicalId],
  );
  await upgradeMainTestDb(populated, "0225_task_launch_agent_preparation");
  fresh = await startMainPostgresTestDb({ databaseName: "create_owner_fresh" });
}, 180_000);

afterAll(async () => {
  await fresh?.stop();
  await populated?.stop();
});

it("preserves historical private requests byte-for-byte through populated upgrade and journal replay", async () => {
  await migrate(populated.db, { migrationsFolder: "./lib/db/migrations" });
  expect(
    (
      await populated.pool.query(
        "SELECT to_jsonb(c) AS value FROM execution_commands c WHERE id=$1",
        [historicalId],
      )
    ).rows[0].value,
  ).toEqual(historical);
  await expect(
    populated.pool.query(
      "UPDATE execution_commands SET create_intent=(SELECT create_intent FROM execution_commands WHERE id=$2) WHERE id=$1",
      [historicalUnknownId, historicalId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "execution_commands_immutable_create_intent",
  });
});

it("fresh schema accepts a closed private continuation and refuses missing or arbitrary owner fields", async () => {
  await expect(
    commandFixture(
      fresh,
      {
        variant: "scratch",
        scratchRunId: "scratch-run",
        turnId: "placement-turn",
        promptOrdinal: 0,
      },
      "scratch-create:placement-turn:0",
      {
        version: 1,
        kind: "initial",
        sourceMessageId: null,
        payload: { stepId: "scratch", prompt: "Frozen initial request" },
      },
    ),
  ).resolves.toEqual(expect.any(String));
  await expect(
    commandFixture(
      fresh,
      {
        variant: "scratch",
        scratchRunId: "scratch-run",
        turnId: "placement-turn",
        promptOrdinal: 0,
      },
      "scratch-create:placement-turn:0",
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "execution_commands_create_intent_check",
  });
  await expect(
    commandFixture(
      fresh,
      {
        variant: "gate_chat",
        turnId: "turn",
        hitlRequestId: "hitl",
        userMessageId: "message",
        bypass: "manual",
      },
      "gate-chat-create:turn",
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "execution_commands_create_intent_check",
  });
});
