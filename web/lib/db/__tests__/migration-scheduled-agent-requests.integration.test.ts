import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseScheduledRequestSnapshot } from "@/lib/agents/scheduled-request";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
const legacyRunId = randomUUID();
const legacyScheduleId = randomUUID();
const legacyAttemptId = randomUUID();
const legacyAgentId = "upgrade:legacy";
let legacySchedule: unknown;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "scheduled_request_upgrade" },
    "0212_run_peek_notifications",
  );
  projectId = (await seedProjectRow(database.db)).id;
  await seedRun(database.db, { id: legacyRunId, projectId });
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES ($1,'upgrade','v1','git','Legacy','Legacy','none','session','[\"cron\"]','read_only','/unused/legacy.md')",
    [legacyAgentId],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,project_id,agent_id,schedules_revision) VALUES ($1,$2,$3,7)",
    [randomUUID(), projectId, legacyAgentId],
  );
  await database.pool.query(
    "INSERT INTO agent_schedules(id,project_id,agent_id,trigger_type,cron_expr,timezone,next_fire_at,last_attempt_fence) VALUES ($1,$2,$3,'cron','*/15 * * * *','UTC','2030-01-01T00:00:00Z',1)",
    [legacyScheduleId, projectId, legacyAgentId],
  );
  legacySchedule = (
    await database.pool.query(
      "SELECT to_jsonb(s) AS value FROM agent_schedules s WHERE id=$1",
      [legacyScheduleId],
    )
  ).rows[0].value;
  await database.pool.query(
    "INSERT INTO agent_trigger_attempts(id,project_id,source_agent_id,schedule_id,binding_snapshot,fence,delivery_key,trigger_source,reserved_run_id,claimed_at,due_at) VALUES ($1,$2,$3,$4,$5::jsonb,1,'cron:1','cron',$6,now(),now())",
    [
      legacyAttemptId,
      projectId,
      legacyAgentId,
      legacyScheduleId,
      JSON.stringify({
        version: 1,
        scheduleId: legacyScheduleId,
        triggerType: "cron",
        cronExpr: "*/15 * * * *",
        timezone: "UTC",
        eventKinds: [],
      }),
      randomUUID(),
    ],
  );

  const journal = JSON.parse(
    await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };
  const cutoff = journal.entries.find(
    (entry) => entry.tag === "0212_run_peek_notifications",
  )!.when;
  const applied = readMigrationFiles({
    migrationsFolder: "./lib/db/migrations",
  }).filter((migration) => migration.folderMillis <= cutoff);

  await database.pool.query(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  await database.pool.query(
    "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT * FROM unnest($1::text[],$2::bigint[])",
    [
      applied.map((entry) => entry.hash),
      applied.map((entry) => entry.folderMillis),
    ],
  );
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("scheduled request additive migration", () => {
  it("keeps legacy input unknown and allows lifecycle changes but no input mutation", async () => {
    const legacy = await database.pool.query(
      "SELECT scheduled_request_snapshot FROM runs WHERE id=$1",
      [legacyRunId],
    );

    expect(legacy.rows[0].scheduled_request_snapshot).toBeNull();
    const schedule = (
      await database.pool.query(
        "SELECT to_jsonb(s)-'request_at_launch' AS value,request_at_launch FROM agent_schedules s WHERE id=$1",
        [legacyScheduleId],
      )
    ).rows[0];

    expect(schedule.value).toEqual(legacySchedule);
    expect(schedule.request_at_launch).toBeNull();
    expect(
      (
        await database.pool.query(
          "SELECT schedules_revision FROM agent_project_links WHERE agent_id=$1",
          [legacyAgentId],
        )
      ).rows[0].schedules_revision,
    ).toBe(7);
    expect(
      (
        await database.pool.query(
          "SELECT scheduled_request_snapshot FROM agent_trigger_attempts WHERE id=$1",
          [legacyAttemptId],
        )
      ).rows[0].scheduled_request_snapshot,
    ).toBeNull();
    await expect(
      database.pool.query(
        "UPDATE agent_trigger_attempts SET scheduled_request_snapshot=$2::jsonb WHERE id=$1",
        [
          legacyAttemptId,
          JSON.stringify({
            version: 1,
            scheduleId: legacyScheduleId,
            triggerAttemptId: legacyAttemptId,
            requestAtLaunch: null,
          }),
        ],
      ),
    ).rejects.toMatchObject({
      constraint: "agent_trigger_attempt_identity_immutable",
    });

    const id = randomUUID();
    const snapshot = {
      version: 1,
      scheduleId: randomUUID(),
      triggerAttemptId: randomUUID(),
      requestAtLaunch: "Проверить статус\n😀",
    };

    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,scheduled_request_snapshot) VALUES($1,$2,'scratch','Pending','scratch','manual',$3)",
      [id, projectId, snapshot],
    );
    await database.pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
      id,
    ]);
    await expect(
      database.pool.query(
        "UPDATE runs SET scheduled_request_snapshot=NULL WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ constraint: "runs_scheduled_request_immutable" });
    await expect(
      database.pool.query(
        "UPDATE runs SET scheduled_request_snapshot=$2 WHERE id=$1",
        [legacyRunId, snapshot],
      ),
    ).rejects.toMatchObject({ constraint: "runs_scheduled_request_immutable" });
  });

  it("rejects malformed present snapshots while accepting captured empty input", async () => {
    const base = {
      version: 1,
      scheduleId: randomUUID(),
      triggerAttemptId: randomUUID(),
      requestAtLaunch: null,
    };
    const invalid: unknown[] = [
      null,
      [],
      42,
      "scalar",
      {},
      { ...base, version: 2 },
      { ...base, requestAtLaunch: 4 },
      { ...base, requestAtLaunch: "" },
      { ...base, requestAtLaunch: "😀".repeat(8001) },
      { ...base, extra: true },
      { ...base, scheduleId: "" },
      { ...base, scheduleId: "😀".repeat(257) },
      {
        version: 1,
        scheduleId: base.scheduleId,
        triggerAttemptId: base.triggerAttemptId,
      },
    ];

    for (const snapshot of invalid) {
      await expect(
        database.pool.query(
          "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,scheduled_request_snapshot) VALUES($1,$2,'scratch','Pending','scratch','manual',$3)",
          [randomUUID(), projectId, JSON.stringify(snapshot)],
        ),
      ).rejects.toMatchObject({ constraint: "runs_scheduled_request_shape" });
    }
    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,scheduled_request_snapshot) VALUES($1,$2,'scratch','Pending','scratch','manual',$3)",
      [randomUUID(), projectId, base],
    );
    const unicodeOrigin = { ...base, scheduleId: "😀".repeat(256) };

    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,scheduled_request_snapshot) VALUES($1,$2,'scratch','Pending','scratch',$3)",
      [randomUUID(), projectId, unicodeOrigin],
    );
    expect(parseScheduledRequestSnapshot(unicodeOrigin)).toEqual(unicodeOrigin);
  });
});
