import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { resolve } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  canonicalSqlDrift,
  readCanonicalSql,
  readCommittedCanonicalSql,
} from "@/lib/db/canonical-sql";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "canonical_sql_gate",
  });
}, 300000);

afterAll(async () => {
  await database?.stop();
});

it("keeps lib/db/canonical equal to the functions and triggers the migrations produce", async () => {
  const live = await readCanonicalSql(database.pool);

  // Regenerate with `pnpm --filter maister-web db:canonical-sql` after a migration
  // that adds, replaces or drops a function or trigger.
  expect(
    canonicalSqlDrift(readCommittedCanonicalSql(resolve(".")), live),
  ).toEqual([]);
  expect(live.get("guard_specialist_work.sql")).toContain(
    "CREATE OR REPLACE FUNCTION public.guard_specialist_work()",
  );
});
