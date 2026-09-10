import "server-only";

import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type MigrationJournalEntry = { tag: string };
type MigrationJournal = { entries: MigrationJournalEntry[] };

// Drizzle applies every journal entry present in a migration root. Building a
// short-lived root through (but excluding) the cut-over lets db:migrate bring an older
// deployment up to the D2 boundary, inspect the exact candidate set, then apply
// cut-over and any later migrations through the canonical root.
export async function createMigrationRootBefore(
  sourceDir: string,
  targetTag: string,
): Promise<string> {
  return createFilteredMigrationRoot(sourceDir, targetTag, "before");
}

// The inclusive variant: the operator stages (D9) name the LAST migration a
// stage may apply, so they build a root through that tag rather than naming its
// successor.
export async function createMigrationRootThrough(
  sourceDir: string,
  targetTag: string,
): Promise<string> {
  return createFilteredMigrationRoot(sourceDir, targetTag, "through");
}

async function createFilteredMigrationRoot(
  sourceDir: string,
  targetTag: string,
  bound: "before" | "through",
): Promise<string> {
  const journal = JSON.parse(
    await readFile(join(sourceDir, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  const tagIndex = journal.entries.findIndex(
    (entry) => entry.tag === targetTag,
  );

  if (tagIndex < 0) {
    throw new Error(`migration journal does not contain ${targetTag}`);
  }

  const targetIndex = bound === "before" ? tagIndex : tagIndex + 1;
  const targetDir = await mkdtemp(
    join(tmpdir(), `maister-migrations-${bound}-`),
  );

  try {
    await mkdir(join(targetDir, "meta"), { recursive: true });
    await Promise.all(
      journal.entries
        .slice(0, targetIndex)
        .map((entry) =>
          copyFile(
            join(sourceDir, `${entry.tag}.sql`),
            join(targetDir, `${entry.tag}.sql`),
          ),
        ),
    );
    await writeFile(
      join(targetDir, "meta", "_journal.json"),
      JSON.stringify(
        { ...journal, entries: journal.entries.slice(0, targetIndex) },
        null,
        2,
      ),
    );

    return targetDir;
  } catch (err) {
    await rm(targetDir, { force: true, recursive: true });
    throw err;
  }
}
