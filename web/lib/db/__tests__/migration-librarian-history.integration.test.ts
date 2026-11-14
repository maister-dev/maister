import { randomUUID } from "node:crypto";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";

import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const cutoff = "0228_workspace_branch_delivery";
const indexes = [
  "librarian_cards_history_idx",
  "librarian_operations_history_idx",
  "librarian_task_links_history_idx",
];

async function historyIndexes(
  database: StartedPostgresTestDb,
): Promise<string[]> {
  const { rows } = await database.pool.query<{
    indexname: string;
    indexdef: string;
  }>(
    "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1) ORDER BY indexname",
    [indexes],
  );

  for (const row of rows)
    expect(row.indexdef).toContain(
      "USING btree (conversation_id, created_at DESC NULLS LAST, id DESC NULLS LAST)",
    );

  return rows.map((row) => row.indexname);
}

it("preserves legacy ledger rows during upgrade and repeat, with the same fresh indexes", async () => {
  const database = await startMainPostgresTestDbUpTo(
    { databaseName: "librarian_history_previous" },
    cutoff,
  );

  try {
    expect(await historyIndexes(database)).toEqual([]);
    const [owner, conversation, segment, operation] = Array.from(
      { length: 4 },
      () => randomUUID(),
    );

    await database.pool.query(
      "INSERT INTO users(id,email,role) VALUES ($1,$2,'member')",
      [owner, `${owner}@test.invalid`],
    );
    await database.pool.query(
      "INSERT INTO librarian_conversations(id,user_id,history_generation,current_segment_id) VALUES ($1,$2,2,$3)",
      [conversation, owner, segment],
    );
    await database.pool.query(
      "INSERT INTO librarian_segments(id,conversation_id,ordinal,started_at) VALUES ($1,$2,0,now())",
      [segment, conversation],
    );
    await database.pool.query(
      "INSERT INTO librarian_operations(id,conversation_id,segment_id,idempotency_key,kind,request_digest,target,status,result) VALUES ($1,$2,$3,'legacy','relation_add','digest','{}','succeeded','{\"body\":{\"ok\":true}}')",
      [operation, conversation, segment],
    );
    const before = await database.pool.query(
      "SELECT * FROM librarian_operations WHERE id=$1",
      [operation],
    );

    await upgradeMainTestDb(database, cutoff);
    expect(await historyIndexes(database)).toEqual(indexes);
    const ledger = await database.pool.query(
      "SELECT count(*) FROM drizzle.__drizzle_migrations",
    );

    await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
    expect(
      (
        await database.pool.query(
          "SELECT count(*) FROM drizzle.__drizzle_migrations",
        )
      ).rows,
    ).toEqual(ledger.rows);
    expect(
      (
        await database.pool.query(
          "SELECT * FROM librarian_operations WHERE id=$1",
          [operation],
        )
      ).rows,
    ).toEqual(before.rows);
    const fresh = await startMainPostgresTestDb({
      databaseName: "librarian_history_fresh",
    });

    try {
      expect(await historyIndexes(fresh)).toEqual(indexes);
    } finally {
      await fresh.stop();
    }
  } finally {
    await database.stop();
  }
}, 60_000);
