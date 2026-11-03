import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_upgrade" },
    "0214_transcript_creation_order",
  );
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("IT-CBX-01 company migration preserves existing project data and identity across repeated boot", async () => {
  const project = await seedProjectRow(database.db);
  const run = await seedRun(database.db, { projectId: project.id });

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES ('legacy-admin','legacy-admin@example.test','admin','active')",
  );
  const before = await database.pool.query<{ value: unknown }>(
    "SELECT to_jsonb(r) AS value FROM runs r WHERE id=$1",
    [run],
  );
  const oldEvent = (
    await database.pool.query<{ id: string; value: Record<string, unknown> }>(
      "INSERT INTO domain_events(kind,project_id,payload,occurred_at) VALUES('task.created',$1,$2::jsonb,now()) RETURNING id,to_jsonb(domain_events) AS value",
      [project.id, JSON.stringify({ legacySnapshot: "preserve exactly" })],
    )
  ).rows[0]!;
  const journal = JSON.parse(
    await readFile("./lib/db/migrations/meta/_journal.json", "utf8"),
  ) as {
    entries: { tag: string; when: number }[];
  };
  const baseline = journal.entries.find(
    (entry) => entry.tag === "0214_transcript_creation_order",
  );

  expect(baseline).toBeDefined();
  const applied = readMigrationFiles({
    migrationsFolder: "./lib/db/migrations",
  }).filter((migration) => migration.folderMillis <= baseline!.when);

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
  const company = await database.pool.query<{ id: string }>(
    "SELECT id FROM companies",
  );

  expect(company.rows).toHaveLength(1);
  expect(
    await database.pool.query("SELECT id FROM company_grants"),
  ).toMatchObject({ rowCount: 0 });
  const after = (
    await database.pool.query<{ value: Record<string, unknown> }>(
      "SELECT to_jsonb(r) AS value FROM runs r WHERE id=$1",
      [run],
    )
  ).rows[0]!.value;

  expect(after).toMatchObject(before.rows[0]!.value as Record<string, unknown>);
  expect(after.knowledge_access).toBeNull();
  expect(Object.keys(after).sort()).toEqual(
    [
      ...Object.keys(before.rows[0]!.value as Record<string, unknown>),
      "knowledge_access",
    ].sort(),
  );
  expect(
    await database.pool.query("SELECT id FROM users WHERE id='legacy-admin'"),
  ).toMatchObject({ rowCount: 1 });
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(e) AS value FROM domain_events e WHERE id=$1",
        [oldEvent.id],
      )
    ).rows[0]?.value,
  ).toEqual({ ...oldEvent.value, company_id: null });
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,project_id,company_id,payload,occurred_at) VALUES('knowledge.record_changed',$1,$2,'{}',now())",
      [project.id, company.rows[0]!.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_owner_check",
  });
  await expect(
    database.pool.query(
      "INSERT INTO domain_events(kind,company_id,payload,occurred_at) VALUES('task.created',$1,'{}',now())",
      [company.rows[0]!.id],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "domain_events_company_kind_check",
  });
  await expect(
    database.pool.query(
      "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
      [
        run,
        JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          generation: "1",
          restrictions: [],
        }),
      ],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "runs_knowledge_access_check",
  });
  await expect(
    database.pool.query(
      "UPDATE runs SET knowledge_access=$2::jsonb WHERE id=$1",
      [
        run,
        JSON.stringify({ schemaVersion: 1, state: "complete", generation: 1 }),
      ],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "runs_knowledge_access_check",
  });
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
  expect((await database.pool.query("SELECT id FROM companies")).rows).toEqual(
    company.rows,
  );
});

it("IT-CBX-01 populated Brain upgrade preserves honest legacy provenance and pending proposals", async () => {
  const legacy = await startMainPostgresTestDb({
    databaseName: "legacy_brain_upgrade",
  });
  const directory = await mkdtemp(join(tmpdir(), "maister-brain-baseline-"));

  try {
    const journal = JSON.parse(
      await readFile("./lib/db/brain-migrations/meta/_journal.json", "utf8"),
    ) as {
      version: string;
      dialect: string;
      entries: { idx: number; tag: string; when: number }[];
    };
    const entries = journal.entries.filter((entry) => entry.idx <= 5);

    await mkdir(join(directory, "meta"));
    await writeFile(
      join(directory, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries }),
    );
    for (const entry of entries)
      await cp(
        `./lib/db/brain-migrations/${entry.tag}.sql`,
        join(directory, `${entry.tag}.sql`),
      );
    await migrate(legacy.db, {
      migrationsFolder: directory,
      migrationsTable: "__drizzle_brain_migrations",
    });
    const project = await seedProjectRow(legacy.db);

    await legacy.pool.query(
      "INSERT INTO brain_items(id,project_id,kind,title,content,confidence,content_hash) VALUES('legacy-claim',$1,'state_fact','Original','Original assertion',0.99,'legacy-hash')",
      [project.id],
    );
    await legacy.pool.query(
      'INSERT INTO brain_proposals(id,project_id,kind,draft,actor) VALUES(\'legacy-proposal\',$1,\'state\',\'{"text":"Pending improvement"}\',\'{"type":"system","id":"legacy-harvest"}\')',
      [project.id],
    );
    await migrate(legacy.db, {
      migrationsFolder: "./lib/db/brain-migrations",
      migrationsTable: "__drizzle_brain_migrations",
    });
    expect(
      (
        await legacy.pool.query(
          "SELECT source_restrictions,source_acl_key FROM brain_proposals WHERE id='legacy-proposal'",
        )
      ).rows,
    ).toEqual([
      {
        source_restrictions: null,
        source_acl_key:
          "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
      },
    ]);
    const table = await legacy.pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.brain_record_revisions') IS NOT NULL AS present",
    );

    expect(table.rows[0]?.present).toBe(true);
    const revision = await legacy.pool.query(
      "SELECT assertion,basis,provenance,attribution,freshness FROM brain_record_revisions WHERE record_id='legacy-claim' AND revision=1",
    );

    expect(revision.rows).toEqual([
      expect.objectContaining({
        assertion: "Original assertion",
        basis: "unknown",
        provenance: "legacy_migration",
        attribution: {
          kind: "legacy_unknown",
          id: null,
          runId: null,
          attemptId: null,
        },
        freshness: expect.objectContaining({
          applicability: "unknown",
          observedAt: null,
          sourceAt: null,
        }),
      }),
    ]);
    expect(
      await legacy.pool.query(
        "SELECT id FROM brain_record_changes WHERE record_id='legacy-claim'",
      ),
    ).toMatchObject({ rowCount: 0 });
    expect(
      (
        await legacy.pool.query(
          "SELECT id,status,draft FROM brain_proposals WHERE id='legacy-proposal'",
        )
      ).rows,
    ).toEqual([
      {
        id: "legacy-proposal",
        status: "pending",
        draft: { text: "Pending improvement" },
      },
    ]);
    await migrate(legacy.db, {
      migrationsFolder: "./lib/db/brain-migrations",
      migrationsTable: "__drizzle_brain_migrations",
    });
    expect(
      await legacy.pool.query(
        "SELECT record_id FROM brain_record_revisions WHERE record_id='legacy-claim'",
      ),
    ).toMatchObject({ rowCount: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await legacy.stop();
  }
});

it("IT-CBX-01 company grant receipt migration preserves existing policy without inventing historical delivery or revocation authority", async () => {
  const legacy = await startMainPostgresTestDbUpTo(
    { databaseName: "company_grant_upgrade" },
    "0231_company_knowledge_events",
  );

  try {
    const companyId = String(
      (await legacy.pool.query("SELECT id FROM companies")).rows[0].id,
    );

    await legacy.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES('existing-policy-author','existing-policy-author@example.test','admin','active')",
    );
    await legacy.pool.query(
      "INSERT INTO company_grants(id,company_id,principal_type,principal_id,action,created_by,revoked_at) VALUES('existing-live-policy',$1,'user','existing-policy-author','knowledge:read','existing-policy-author',NULL),('existing-revoked-policy',$1,'user','existing-policy-author','knowledge:review','existing-policy-author',now())",
      [companyId],
    );
    const before = (
      await legacy.pool.query(
        "SELECT to_jsonb(g) AS value FROM company_grants g ORDER BY id",
      )
    ).rows.map((row) => row.value);

    await legacy.db.transaction(async (tx) => {
      await applyMainMigration(tx, "0232_company_grant_requests");
    });
    const after = (
      await legacy.pool.query(
        "SELECT to_jsonb(g) AS value FROM company_grants g ORDER BY id",
      )
    ).rows.map((row) => row.value);

    expect(after).toEqual(
      before.map((value) => ({
        ...value,
        creation_key: null,
        creation_digest: null,
        revocation_key: null,
        revocation_digest: null,
        revoked_by: null,
        revocation_reason: null,
      })),
    );
    await expect(
      legacy.pool.query(
        "UPDATE company_grants SET principal_id='a-new-principal' WHERE id='existing-live-policy'",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "company_grants_history_immutable",
    });
    await expect(
      legacy.pool.query(
        "UPDATE company_grants SET revoked_at=NULL WHERE id='existing-revoked-policy'",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "company_grants_history_immutable",
    });
    await expect(
      legacy.pool.query(
        "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by,creation_key) VALUES($1,'user','existing-policy-author','knowledge:propose','existing-policy-author','incomplete_receipt')",
        [companyId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "company_grants_creation_receipt_check",
    });
    await expect(
      legacy.pool.query(
        "UPDATE company_grants SET revoked_at=now(),revision=2,revocation_key='incomplete_revocation' WHERE id='existing-live-policy'",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "company_grants_revocation_receipt_check",
    });
    await legacy.pool.query(
      "UPDATE company_grants SET revoked_at=now() WHERE id='existing-live-policy'",
    );
    expect(
      (
        await legacy.pool.query(
          "SELECT revision,revoked_by,revocation_key FROM company_grants WHERE id='existing-live-policy'",
        )
      ).rows,
    ).toEqual([{ revision: 1, revoked_by: null, revocation_key: null }]);
  } finally {
    await legacy.stop();
  }
}, 180000);
