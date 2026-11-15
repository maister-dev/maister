/* eslint-disable no-console */
// Regenerates lib/db/canonical/ from a freshly migrated (main + Brain) test
// database: one file per function, plus _triggers.sql.
// `--check` compares instead and exits 2 on drift. Requires Docker.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  CANONICAL_SQL_DIR,
  canonicalSqlDrift,
  readCanonicalSql,
  readCommittedCanonicalSql,
} from "@/lib/db/canonical-sql";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

const wantCheck = process.argv.slice(2).includes("--check");

async function main(): Promise<void> {
  const database = await startMainAndBrainPostgresTestDb({
    databaseName: "canonical_sql",
  });

  try {
    const live = await readCanonicalSql(database.pool);
    const root = resolve(".");

    if (wantCheck) {
      const drift = canonicalSqlDrift(readCommittedCanonicalSql(root), live);

      if (drift.length) {
        console.error(
          `generate-canonical-sql --check: ${drift.length} file(s) drifted: ${drift.join(", ")}. Run \`pnpm --filter maister-web db:canonical-sql\` and commit the result.`,
        );
        process.exitCode = 2;

        return;
      }
      console.log(
        `generate-canonical-sql --check: ${live.size} file(s) current`,
      );

      return;
    }
    const directory = join(root, CANONICAL_SQL_DIR);

    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    for (const [file, text] of live) writeFileSync(join(directory, file), text);
    console.log(`generate-canonical-sql: wrote ${live.size} file(s) to ${directory}`);
  } finally {
    await database.stop();
  }
}

main().catch((error: unknown) => {
  console.error("generate-canonical-sql failed:", error);
  process.exitCode = 1;
});
