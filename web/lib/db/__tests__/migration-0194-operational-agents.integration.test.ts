import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { operationalContractFixture } from "@/test-support/operational-agent";

let database: StartedPostgresTestDb;
let projectId: string;
const historical = [
  "Pending",
  "Running",
  "NeedsInputIdle",
  "Review",
  "Done",
  "Failed",
].map((status) => ({ id: randomUUID(), status }));

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "operational_upgrade" },
    "0193_numerous_spectrum",
  );
  projectId = (await seedProjectRow(database.db)).id;
  for (const row of historical)
    await seedRun(database.db, { ...row, projectId, runKind: "agent" });
  const journal = JSON.parse(
    await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };
  const cutoff = journal.entries.find(
    (entry) => entry.tag === "0193_numerous_spectrum",
  )?.when;

  if (!cutoff) throw new Error("missing upgrade baseline");
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

describe("operational migration", () => {
  it("IT-OPA-02 IT-OPA-07 IT-EDGE-OPA-03 preserves historical semantics and refuses contradictory operational snapshots", async () => {
    const rows = await database.pool.query(
      "SELECT id, status, agent_kind, operational_terminal FROM runs ORDER BY id",
    );

    expect(rows.rows).toEqual(
      historical
        .map((row) => ({
          ...row,
          agent_kind: null,
          operational_terminal: null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    await expect(
      database.pool.query(
        "UPDATE runs SET agent_kind = 'operational' WHERE id = $1",
        [historical[1].id],
      ),
    ).rejects.toMatchObject({
      constraint: "runs_operational_snapshot_immutable",
    });
    await expect(
      database.pool.query(
        "INSERT INTO runs (id,project_id,run_kind,status,flow_version,flow_revision,agent_kind) VALUES ($1,$2,'agent','Running','agent','manual','operational')",
        [randomUUID(), projectId],
      ),
    ).rejects.toMatchObject({ constraint: "runs_operational_contract_check" });
    await expect(
      database.pool.query(
        "UPDATE runs SET operational_cleanup = '[]'::jsonb WHERE id = $1",
        [historical[1].id],
      ),
    ).rejects.toMatchObject({ constraint: "runs_operational_cleanup_check" });
    await expect(
      database.pool.query(
        "UPDATE runs SET operational_terminal = '{}'::jsonb WHERE id = $1",
        [historical[1].id],
      ),
    ).rejects.toMatchObject({ constraint: "runs_operational_terminal_check" });
  });

  it("requires exact reader reason/revision and preserves acknowledgement identity", async () => {
    const userId = randomUUID();

    await database.pool.query("INSERT INTO users (id,email) VALUES ($1,$2)", [
      userId,
      `${userId}@example.test`,
    ]);
    await database.pool.query(
      "INSERT INTO operational_run_acknowledgements(user_id,run_id,reason,revision) VALUES ($1,$2,'operation_failure',1)",
      [userId, historical[5].id],
    );
    await expect(
      database.pool.query(
        "INSERT INTO operational_run_acknowledgements(user_id,run_id,reason,revision) VALUES ($1,$2,'operation_failure',1)",
        [userId, historical[5].id],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      database.pool.query(
        "INSERT INTO operational_run_acknowledgements(user_id,run_id,reason,revision) VALUES ($1,$2,'other',0)",
        [userId, historical[5].id],
      ),
    ).rejects.toMatchObject({
      constraint: "operational_ack_reason_revision_check",
    });
  });

  it("protects source and exact platform-generation prefixes through the normal migration chain", async () => {
    const runId = randomUUID();

    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,agent_kind,agent_workspace,result_contract) VALUES($1,$2,'agent','Running','agent','manual','operational','none',$3::jsonb)",
      [runId, projectId, JSON.stringify(operationalContractFixture("none"))],
    );
    const baseline = {
      version: 1,
      generation: 0,
      capturedAt: new Date().toISOString(),
      resourceKind: "plain_directory",
      head: null,
      branch: null,
      indexDigest: null,
      indexContentDigest: null,
      historyDigest: null,
      gitIdentity: null,
      refs: [],
      source: [],
      platform: [],
    };
    const write = (value: object) =>
      database.pool.query(
        "UPDATE runs SET operational_integrity_baseline=$2::jsonb WHERE id=$1",
        [runId, JSON.stringify(value)],
      );

    await write(baseline);
    const a = {
      path: ".claude/a",
      type: "file",
      mode: 420,
      sha256: "a".repeat(64),
    };
    const b = {
      path: ".claude/b",
      type: "file",
      mode: 420,
      sha256: "b".repeat(64),
    };

    await write({ ...baseline, generation: 1, platform: [a] });
    await write({ ...baseline, generation: 2, platform: [a, b] });
    await expect(
      write({ ...baseline, generation: 3, platform: [b, a] }),
    ).rejects.toMatchObject({
      constraint: "runs_operational_baseline_immutable",
    });
    await expect(
      write({ ...baseline, generation: 3, platform: [a, b], source: [a] }),
    ).rejects.toMatchObject({
      constraint: "runs_operational_baseline_immutable",
    });
    await write({ ...baseline, generation: 3, platform: [a, b, a] });
  });

  it("admits a real supported snapshot and enforces immutable semantics and result linkage", async () => {
    const runId = randomUUID();
    const contract = operationalContractFixture();

    await database.pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,agent_kind,agent_workspace,result_contract) VALUES($1,$2,'agent','Pending','agent','manual','operational','worktree',$3::jsonb)",
      [runId, projectId, JSON.stringify(contract)],
    );
    await expect(
      database.pool.query(
        "UPDATE runs SET agent_kind = 'code_delivery', result_contract = null WHERE id = $1",
        [runId],
      ),
    ).rejects.toMatchObject({
      constraint: "runs_operational_snapshot_immutable",
    });
    await expect(
      database.pool.query("UPDATE runs SET status = 'Review' WHERE id = $1", [
        runId,
      ]),
    ).rejects.toMatchObject({ constraint: "runs_operational_terminal_check" });
    const receipt = {
      version: 1,
      status: "Done",
      cause: "completed",
      effectiveOutcome: "success",
      successful: true,
      validation: "valid",
      integrity: "clean",
      baselineGeneration: 1,
      resultRevision: 1,
      reasonCodes: [],
      evidenceIds: [],
    };

    await expect(
      database.pool.query(
        "UPDATE runs SET status = 'Done', operational_terminal = $2::jsonb WHERE id = $1",
        [runId, JSON.stringify(receipt)],
      ),
    ).rejects.toMatchObject({
      constraint: "runs_operational_result_receipt_check",
    });
    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows[0].status,
    ).toBe("Pending");
  });

  it("reruns the normal migrator without altering the ledger or historical rows", async () => {
    const before = await database.pool.query(
      "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
    );

    await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
    expect(
      (
        await database.pool.query(
          "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM runs WHERE agent_kind IS NULL",
        )
      ).rows[0].n,
    ).toBe(historical.length);
  });

  it("rolls back all DDL and its receipt when an incremental migration fails", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "operational-migration-rollback-"),
    );
    const prior = await database.pool.query(
      "SELECT count(*)::int AS n, max(created_at)::bigint AS latest FROM drizzle.__drizzle_migrations",
    );

    try {
      await mkdir(join(root, "meta"));
      await writeFile(
        join(root, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              tag: "0000_fail",
              when: Number(prior.rows[0].latest) + 1,
              breakpoints: true,
            },
          ],
        }),
      );
      await writeFile(
        join(root, "0000_fail.sql"),
        "CREATE TABLE operational_rollback_probe(id text);\n--> statement-breakpoint\nSELECT 1/0;",
      );
      await expect(
        migrate(database.db, { migrationsFolder: root }),
      ).rejects.toThrow();
      expect(
        (
          await database.pool.query(
            "SELECT to_regclass('operational_rollback_probe') AS object",
          )
        ).rows[0].object,
      ).toBeNull();
      expect(
        (
          await database.pool.query(
            "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
          )
        ).rows[0].n,
      ).toBe(prior.rows[0].n);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
