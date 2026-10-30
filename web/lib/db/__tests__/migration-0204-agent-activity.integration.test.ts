import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
const legacyRunId = randomUUID();

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "agent_activity_upgrade" },
    "0203_pink_synch",
  );
  projectId = (await seedProjectRow(database.db)).id;
  await seedRun(database.db, { id: legacyRunId, projectId, runKind: "agent" });
  const journal = JSON.parse(
    await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
  ) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const cutoff = journal.entries.find(
    (entry) => entry.tag === "0203_pink_synch",
  )?.when;

  if (!cutoff) throw new Error("missing activity upgrade baseline");
  const applied = readMigrationFiles({
    migrationsFolder: "./lib/db/migrations",
  }).filter((migration) => migration.folderMillis <= cutoff);

  await database.pool.query(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  await database.pool.query(
    "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT * FROM unnest($1::text[],$2::bigint[])",
    [
      applied.map((migration) => migration.hash),
      applied.map((migration) => migration.folderMillis),
    ],
  );
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-UX-01 UX-IT01 activity migration", () => {
  it("preserves unknown legacy launch time and rejects mutation of a new frozen identity", async () => {
    expect(
      (
        await database.pool.query(
          "SELECT source_agent_id,launched_at,agent_activity_snapshot FROM runs WHERE id=$1",
          [legacyRunId],
        )
      ).rows[0],
    ).toEqual({
      source_agent_id: null,
      launched_at: null,
      agent_activity_snapshot: null,
    });
    const runId = randomUUID();
    const snapshot = {
      version: 1,
      agentId: "core:triager",
      displayName: "Triager",
      definitionSha256: "a".repeat(64),
      packageInstallId: "install",
      packageName: "core",
      packageVersion: "test",
      packageRevision: "b".repeat(40),
    };

    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,source_agent_id,launched_at,activity_sort_at,activity_timestamp_provenance,agent_activity_snapshot) VALUES($1,$2,'agent','Pending','agent','manual','core:triager',clock_timestamp(),clock_timestamp(),'launch',$3::jsonb)",
      [runId, projectId, JSON.stringify(snapshot)],
    );
    await database.pool.query(
      "UPDATE runs SET started_at=clock_timestamp(),status='Running' WHERE id=$1",
      [runId],
    );
    await expect(
      database.pool.query(
        "UPDATE runs SET launched_at=clock_timestamp() WHERE id=$1",
        [runId],
      ),
    ).rejects.toMatchObject({ constraint: "runs_agent_activity_immutable" });
    await expect(
      database.pool.query(
        "UPDATE runs SET source_agent_id='other:agent' WHERE id=$1",
        [runId],
      ),
    ).rejects.toMatchObject({ constraint: "runs_agent_activity_immutable" });
  });

  it("enforces open-cause uniqueness and keeps occurrences after run evidence expires", async () => {
    const episodeId = randomUUID();
    const values = [episodeId, projectId];

    await database.pool.query(
      "INSERT INTO agent_incident_episodes(id,project_id,source_agent_id,scope_key,scope_kind,fingerprint,reason_code) VALUES($1,$2,'core:triager','scope','infrastructure','cause','provider_auth')",
      values,
    );
    await expect(
      database.pool.query(
        "INSERT INTO agent_incident_episodes(project_id,source_agent_id,scope_key,scope_kind,fingerprint,reason_code) VALUES($1,'core:triager','scope','infrastructure','cause','provider_auth')",
        [projectId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const disposableRun = randomUUID();

    await seedRun(database.db, {
      id: disposableRun,
      projectId,
      runKind: "agent",
    });
    await database.pool.query(
      "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,run_id,original_run_id,channel,observed_at) VALUES($1,'terminal:1','cause',$2,$2,'execution_failure',clock_timestamp())",
      [episodeId, disposableRun],
    );
    await database.pool.query("DELETE FROM runs WHERE id=$1", [disposableRun]);
    expect(
      (
        await database.pool.query(
          "SELECT run_id,original_run_id FROM agent_incident_occurrences WHERE episode_id=$1",
          [episodeId],
        )
      ).rows,
    ).toEqual([{ run_id: null, original_run_id: disposableRun }]);
    await expect(
      database.pool.query(
        "INSERT INTO agent_incident_occurrences(episode_id,source_fact_key,fingerprint,channel,observed_at) VALUES($1,'terminal:1','cause','execution_failure',clock_timestamp())",
        [episodeId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
  it("IT-UX-15 preserves an accepted retry recipe and source claim", async () => {
    const intentId = randomUUID();
    const successorId = randomUUID();
    const recipe = {
      version: 1,
      agentId: "core:triager",
      projectId,
      taskId: null,
      taskRevision: null,
      definition: {
        parsed: {
          name: "Triager",
          kind: "operational",
          workspace: "none",
          mode: "session",
          prompt: "Inspect task",
          completion: { contract: "operational_v1" },
        },
        packageName: "core",
        packageInstallId: "install",
        installedPath: "/package",
        sourcePath: "/package/triager.md",
        versionLabel: "test",
        execTrust: "trusted",
        manifest: null,
      },
      configuration: {},
      trigger: { source: "manual", eventId: null, payload: null },
      runner: {
        id: "runner-a",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "test",
        providerKind: "anthropic",
        permissionPolicy: "ask",
      },
      policy: { preset: "supervised" },
    };

    await database.pool.query(
      "INSERT INTO agent_retry_intents(id,project_id,source_agent_id,source_run_id,actor_identity,request_key,request_digest,selected_runner_id,recipe,preview_fingerprint,successor_run_id) VALUES($1,$2,'core:triager',$3,'actor',$4,$5,'runner-a',$6::jsonb,$5,$7)",
      [
        intentId,
        projectId,
        legacyRunId,
        randomUUID(),
        "a".repeat(64),
        JSON.stringify(recipe),
        successorId,
      ],
    );
    await expect(
      database.pool.query(
        "UPDATE agent_retry_intents SET request_digest=$2 WHERE id=$1",
        [intentId, "b".repeat(64)],
      ),
    ).rejects.toMatchObject({ constraint: "agent_retry_recipe_immutable" });
    await database.pool.query(
      "UPDATE agent_retry_intents SET lease_owner='worker',lease_fence=1,lease_expires_at=now()+interval '1 minute' WHERE id=$1",
      [intentId],
    );
  });
  it("IT-UX-18 freezes delivery admission independently of later task edits", async () => {
    const taskId = randomUUID();
    const runId = randomUUID();
    const snapshot = {
      version: 1,
      mode: "legacy",
      policyVersion: 1,
      inputRevision: 1,
      qualificationId: null,
      qualificationRevision: null,
      evidenceTarget: null,
      evidenceSha: null,
      parent: null,
    };

    await database.pool.query(
      "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES ($1,$2,700001,'Task','Original input')",
      [taskId, projectId],
    );
    await database.pool.query(
      "INSERT INTO runs(id,project_id,task_id,run_kind,status,flow_version,flow_revision,task_admission_snapshot) VALUES ($1,$2,$3,'agent','Pending','agent','manual',$4)",
      [runId, projectId, taskId, JSON.stringify(snapshot)],
    );
    await database.pool.query(
      "UPDATE tasks SET prompt='New input' WHERE id=$1",
      [taskId],
    );
    expect(
      (
        await database.pool.query(
          "SELECT task_admission_snapshot FROM runs WHERE id=$1",
          [runId],
        )
      ).rows[0].task_admission_snapshot,
    ).toEqual(snapshot);
    await expect(
      database.pool.query(
        "UPDATE runs SET task_admission_snapshot=NULL WHERE id=$1",
        [runId],
      ),
    ).rejects.toMatchObject({ constraint: "runs_task_admission_immutable" });
  });
});
