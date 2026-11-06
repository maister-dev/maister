import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { afterAll, beforeAll, expect, it } from "vitest";

import { startMainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "native_source_array",
  });
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("preserves every bounded native source entry and its order despite the planner's small-array estimate", async () => {
  const entries = Array.from({ length: 256 }, (_, index) => ({
    kind: "record",
    recordId: `источник-🧠-${index}`,
  }));
  const result = await database.pool.query(
    "SELECT value FROM native_knowledge_source_restrictions($1::jsonb) WITH ORDINALITY source(value,position) ORDER BY position",
    [JSON.stringify(entries)],
  );

  expect(result.rows.map((row: { value: unknown }) => row.value)).toEqual(
    entries,
  );
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM native_knowledge_source_restrictions('[]'::jsonb)",
      )
    ).rows[0],
  ).toEqual({ count: 0 });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS count FROM native_knowledge_source_restrictions(NULL::jsonb)",
      )
    ).rows[0],
  ).toEqual({ count: 0 });
  await expect(
    database.pool.query(
      "SELECT * FROM native_knowledge_source_restrictions('{}'::jsonb)",
    ),
  ).rejects.toMatchObject({ code: "22023" });
});
