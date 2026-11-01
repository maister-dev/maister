import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { startBarePostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let prefix: string;

beforeAll(async () => {
  database = await startBarePostgresTestDb({ databaseName: "peek_upgrade" });
  prefix = await mkdtemp(join(tmpdir(), "peek-migrations-"));
  await mkdir(join(prefix, "meta"));
  const journal = JSON.parse(
    await readFile("lib/db/migrations/meta/_journal.json", "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((entry) => entry.idx <= 209);

  await writeFile(
    join(prefix, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries)
    await cp(
      `lib/db/migrations/${entry.tag}.sql`,
      join(prefix, `${entry.tag}.sql`),
    );
  await migrate(database.db, { migrationsFolder: prefix });
}, 180000);
afterAll(async () => {
  await database?.stop();
  if (prefix) await rm(prefix, { recursive: true, force: true });
});

it("IT-PKD-11: upgrades 0209 with retained data, exact paging indexes and repeatable migration ledger", async () => {
  const id = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,run_kind,status,flow_version,flow_revision) VALUES($1,'agent','Done','v1','r')",
    [id],
  );
  await database.pool.query(
    "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','retained')",
    [randomUUID(), id],
  );
  const attempt = randomUUID();

  await database.pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES($1,$2,'work','ai_coding','Running')",
    [attempt, id],
  );
  const invalid = randomUUID();

  await database.pool.query(
    "INSERT INTO run_messages(id,run_id,node_attempt_id,supervisor_event_id,sequence,role,content) VALUES($1,$2,$3,'legacy-invalid',2,'tool','retained')",
    [invalid, id, attempt],
  );
  await expect(
    migrate(database.db, { migrationsFolder: "lib/db/migrations" }),
  ).rejects.toThrow();
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname LIKE '%peek_%'",
      )
    ).rows[0].n,
  ).toBe(0);
  await database.pool.query(
    "UPDATE run_messages SET supervisor_event_id='1' WHERE id=$1",
    [invalid],
  );
  const before = (
    await database.pool.query(
      "SELECT * FROM run_messages WHERE run_id=$1 ORDER BY id",
      [id],
    )
  ).rows;

  await migrate(database.db, { migrationsFolder: "lib/db/migrations" });
  const indexes = (
    await database.pool.query(
      "SELECT indexname,indexdef FROM pg_indexes WHERE indexname LIKE '%peek_%' ORDER BY indexname",
    )
  ).rows as { indexname: string; indexdef: string }[];

  expect(indexes.map((row) => row.indexname)).toEqual([
    "run_messages_peek_node_order_idx",
    "run_messages_peek_run_order_idx",
    "runs_peek_parent_launch_idx",
  ]);
  expect(indexes[0].indexdef).toContain("supervisor_event_id");
  expect(indexes[0].indexdef).toContain("WHERE (node_attempt_id IS NOT NULL)");
  expect(
    (
      await database.pool.query(
        "SELECT * FROM run_messages WHERE run_id=$1 ORDER BY id",
        [id],
      )
    ).rows,
  ).toEqual(before);
  const ledger = (
    await database.pool.query(
      "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
    )
  ).rows;

  await migrate(database.db, { migrationsFolder: "lib/db/migrations" });
  expect(
    (
      await database.pool.query(
        "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
      )
    ).rows,
  ).toEqual(ledger);
});
