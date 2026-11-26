import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { parseAgentDefinition } from "@/lib/agents/definition";
import { buildOperationalContract } from "@/lib/agents/launch-contract";
import { runs } from "@/lib/db/schema";
import {
  seedLocalHost,
  seedProjectRow,
} from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const legacyHead = "0355_installation_credential_revocation";
const definition =
  "---\nname: Operator\ndescription: Upgrade fixture\nkind: operational\ncompletion: {contract: operational_v1}\nmode: session\nworkspace: repo_read\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nRead the repository.";
let database: StartedPostgresTestDb;
let runId: string;
let newRunId: string;
let assignmentId: string;
let legacy: Readonly<Record<string, unknown>>;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "operational_continuation_upgrade" },
    legacyHead,
  );
  await database.pool.query(
    "SET maister.agent_preparation_writer='v1'; SET maister.task_launch_writer='v3'",
  );
  const { id: projectId } = await seedProjectRow(database.db);
  const { id: hostId } = await seedLocalHost(database.db);
  runId = randomUUID();
  newRunId = randomUUID();
  assignmentId = randomUUID();
  const contract = buildOperationalContract({
    parsed: parseAgentDefinition("fixture:operator", definition),
    sourcePath: "/fixture/maister-agents/operator.md",
    installedPath: "/fixture",
    packageName: "fixture",
    packageInstallId: randomUUID(),
    versionLabel: "v1.0.0",
    resolvedRevision: "rev-1",
    manifest: null,
    execTrust: "trusted",
  });

  await database.pool.query(
    `INSERT INTO runs(id,project_id,run_kind,agent_kind,agent_workspace,status,flow_version,flow_revision,result_contract)
     SELECT id,$2,'agent','operational','repo_read','Running','agent','manual',$3::jsonb
     FROM unnest($1::text[]) AS ids(id)`,
    [[runId, newRunId], projectId, JSON.stringify(contract)],
  );
  await database.pool.query(
    `INSERT INTO execution_assignments(id,run_id,execution_host_id,epoch,state,placement_reason)
     VALUES($1,$2,$3,1,'active','launch')`,
    [assignmentId, runId, hostId],
  );
  await database.pool.query(
    "UPDATE runs SET execution_assignment_id=$1 WHERE id=$2",
    [assignmentId, runId],
  );
  legacy = {
    version: 1,
    generation: 0,
    resourceKind: "ephemeral_checkout",
    capturedAt: new Date().toISOString(),
    head: "a".repeat(40),
    branch: null,
    indexDigest: "b".repeat(64),
    source: [],
    platform: [],
  };
  await database.pool.query(
    "UPDATE runs SET operational_integrity_baseline=$2 WHERE id=$1",
    [runId, JSON.stringify(legacy)],
  );
  await upgradeMainTestDb(database, legacyHead);
  await database.pool.query(
    "SET maister.agent_preparation_writer='v2'; SET maister.task_launch_writer='v3'",
  );
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("IT-APR-02 upgrades a populated operational database and retains frozen witness bytes", async () => {
  const [run] = await database.db
    .select({
      baseline: runs.operationalIntegrityBaseline,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  expect(run.baseline).toEqual(legacy);
  const v2 = {
    ...legacy,
    version: 2,
    indexContentDigest: "c".repeat(64),
    historyDigest: "d".repeat(64),
    gitIdentity: "e".repeat(64),
    gitConfigDigest: "f".repeat(64),
    worktreeConfigDigest: null,
    refs: [],
  };
  const writer = await database.pool.connect();
  try {
    const publish = (id: string, witness: Readonly<Record<string, unknown>>) =>
      writer.query(
        "UPDATE runs SET operational_integrity_baseline=$2 WHERE id=$1",
        [id, JSON.stringify(witness)],
      );
    await writer.query(
      "SET maister.agent_preparation_writer='v1'; SET maister.task_launch_writer='v3'",
    );
    await expect(publish(newRunId, v2)).rejects.toMatchObject({
      constraint: "agent_preparation_writer_capability",
    });
    await writer.query("SET maister.agent_preparation_writer='v2'");
    await expect(
      publish(newRunId, { ...v2, gitConfigDigest: "" }),
    ).rejects.toMatchObject({
      constraint: "runs_operational_baseline_check",
    });
    await expect(publish(newRunId, v2)).resolves.toMatchObject({ rowCount: 1 });
    await expect(publish(runId, v2)).rejects.toMatchObject({ code: "23514" });

    const add = (id: string, key: string, attempts: number) =>
      writer.query(
        "INSERT INTO agent_continuation_episodes(run_id,logical_key,assignment_id,assignment_epoch,state,attempts) VALUES($1,$2,$3,1,'eligible',$4)",
        [id, key, assignmentId, attempts],
      );
    await expect(add(newRunId, "wrong-run", 0)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(add(runId, "impossible", 6)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(add(runId, "resume", 0)).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(add(runId, "other", 0)).rejects.toMatchObject({
      code: "23505",
    });
  } finally {
    writer.release();
  }
});
