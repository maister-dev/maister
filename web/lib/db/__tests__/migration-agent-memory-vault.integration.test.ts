import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { createHash, randomUUID } from "node:crypto";
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

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedAdmin } from "@/test-support/durable-workers-seed";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

const predecessor = "0342_domain_event_run_pr_merged";
const migrationsFolder = "./lib/db/migrations";
const legacyHash = createHash("sha256").update("# Legacy memory").digest("hex");

let database: StartedPostgresTestDb | undefined;
let projectId: string;
let legacyRunId: string;
let emptyRunId: string;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "agent_memory_vault_upgrade" },
    predecessor,
  );
  await declareCurrentTestDatabaseWriter(database);
  projectId = await seedProject(database.db);
  legacyRunId = await seedRun(database.db, { projectId, runKind: "agent" });
  emptyRunId = await seedRun(database.db, { projectId, runKind: "agent" });
  await database.pool.query(
    "UPDATE runs SET agent_memory_hash = $2 WHERE id = $1",
    [legacyRunId, legacyHash],
  );
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("AV-10 preserves raw-file evidence during upgrade and reapply without Brain", async () => {
  const fixture = database!;

  await upgradeMainTestDb(fixture, predecessor);

  const query = () =>
    fixture.pool.query<{
      id: string;
      hash: string | null;
      format: string | null;
    }>(
      "SELECT id, agent_memory_hash AS hash, agent_memory_hash_format AS format FROM runs WHERE id = ANY($1::text[])",
      [[legacyRunId, emptyRunId]],
    );
  const expected = [
    { id: legacyRunId, hash: legacyHash, format: "legacy-file-v1" },
    { id: emptyRunId, hash: null, format: null },
  ];

  expect((await query()).rows).toEqual(expect.arrayContaining(expected));
  expect(
    (
      await fixture.pool.query(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      )
    ).rows,
  ).toEqual([]);
  await migrate(fixture.db, { migrationsFolder });
  expect((await query()).rows).toEqual(expect.arrayContaining(expected));
}, 120_000);

it("AV-01 and AV-03 constrain stable owner identity and exact immutable note lineage", async () => {
  const fixture = database!;
  const vaultId = randomUUID();
  const otherVaultId = randomUUID();
  const noteId = randomUUID();
  const revisionId = randomUUID();
  const otherNoteId = randomUUID();
  const otherRevisionId = randomUUID();
  const adminId = await seedAdmin(fixture.db);
  const client = await fixture.pool.connect();
  const author = JSON.stringify({
    kind: "operator_import",
    userId: "operator",
  });

  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO agent_memory_vaults(id,project_id,agent_id) VALUES ($1,$3,'test:memory'),($2,$3,'test:other')",
      [vaultId, otherVaultId, projectId],
    );
    for (const [vault, note, revision] of [
      [vaultId, noteId, revisionId],
      [otherVaultId, otherNoteId, otherRevisionId],
    ]) {
      await client.query(
        "INSERT INTO agent_memory_notes(id,vault_id,path,head_revision_id) VALUES ($1,$2,'/memories/index.md',$3)",
        [note, vault, revision],
      );
      await client.query(
        "INSERT INTO agent_memory_revisions(id,vault_id,note_id,path,kind,content_sha256,size_chars,size_bytes,author,source_project_ids) VALUES ($1,$2,$3,'/memories/index.md','created',$4,15,15,$5,$6)",
        [revision, vault, note, legacyHash, author, [projectId]],
      );
      await client.query(
        "INSERT INTO agent_memory_revision_payloads(vault_id,note_id,revision_id,content) VALUES ($1,$2,$3,$4)",
        [vault, note, revision, "# Legacy memory"],
      );
    }
    await client.query("COMMIT");

    await expect(
      client.query(
        "INSERT INTO agent_memory_vaults(project_id,agent_id) VALUES ($1,'test:memory')",
        [projectId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      client.query(
        "UPDATE agent_memory_notes SET head_revision_id = $2 WHERE id = $1",
        [noteId, otherRevisionId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        "UPDATE agent_memory_revisions SET author = '{}'::jsonb WHERE id = $1",
        [revisionId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "DELETE FROM agent_memory_revision_payloads WHERE revision_id = $1",
        [revisionId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await client.query(
          "SELECT content FROM agent_memory_revision_payloads WHERE revision_id = $1",
          [revisionId],
        )
      ).rows,
    ).toEqual([{ content: "# Legacy memory" }]);
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO agent_memory_redactions(vault_id,note_id,revision_id,administrator_id,reason) VALUES ($1,$2,$3,$4,'fixture redaction')",
      [vaultId, noteId, revisionId, adminId],
    );
    await client.query(
      "DELETE FROM agent_memory_revision_payloads WHERE revision_id = $1",
      [revisionId],
    );
    const tombstoneId = randomUUID();

    await client.query(
      "INSERT INTO agent_memory_revisions(id,vault_id,note_id,parent_revision_id,path,kind,size_chars,size_bytes,author) VALUES ($1,$2,$3,$4,'/memories/index.md','redacted',0,0,$5)",
      [tombstoneId, vaultId, noteId, revisionId, author],
    );
    await client.query(
      "UPDATE agent_memory_notes SET head_revision_id = $2, deleted_at = now() WHERE id = $1",
      [noteId, tombstoneId],
    );
    await client.query("COMMIT");
    expect(
      (
        await client.query(
          "SELECT r.id, r.content_sha256, p.content FROM agent_memory_revisions r LEFT JOIN agent_memory_revision_payloads p ON p.revision_id = r.id WHERE r.id = $1",
          [revisionId],
        )
      ).rows,
    ).toEqual([{ id: revisionId, content_sha256: legacyHash, content: null }]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("AV-10 installs the vault on a fresh main-only database", async () => {
  const fresh = await startMainPostgresTestDb({
    databaseName: "agent_memory_vault_fresh",
  });

  try {
    const result = await fresh.pool.query(
      "SELECT to_regclass('agent_memory_vaults')::text AS vault, EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS vector",
    );

    expect(result.rows).toEqual([
      { vault: "agent_memory_vaults", vector: false },
    ]);
  } finally {
    await fresh.stop();
  }
}, 180_000);

it("AV-10 upgrades the optional cache over a seeded pre-vault Brain ledger", async () => {
  const fixture = await startMainPostgresTestDb({
    databaseName: "agent_memory_brain_upgrade",
  });
  const previous = await mkdtemp(join(tmpdir(), "maister-brain-previous-"));
  const brain = "./lib/db/brain-migrations";
  const migrationsTable = "__drizzle_brain_migrations";
  try {
    const journal = JSON.parse(
      await readFile(join(brain, "meta", "_journal.json"), "utf8"),
    ) as {
      version: string;
      dialect: string;
      entries: Array<{ tag: string }>;
    };
    const through = journal.entries.findIndex(
      ({ tag }) => tag === "0011_proposal_source_access",
    );
    if (through < 0)
      throw new Error("The previous Brain migration baseline is missing");
    const entries = journal.entries.slice(0, through + 1);
    await mkdir(join(previous, "meta"));
    await writeFile(
      join(previous, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries }),
    );
    await Promise.all(
      entries.map(({ tag }) =>
        copyFile(join(brain, `${tag}.sql`), join(previous, `${tag}.sql`)),
      ),
    );
    await migrate(fixture.db, { migrationsFolder: previous, migrationsTable });
    const project = await seedProject(fixture.db);
    const itemId = randomUUID();
    await fixture.pool.query(
      "INSERT INTO brain_items(id,project_id,kind,title,content,content_hash,confidence) VALUES($1,$2,'state_fact','Legacy fact','Retained Brain content',$3,0.9)",
      [itemId, project, legacyHash],
    );
    const before = await fixture.pool.query(
      "SELECT to_jsonb(item) AS retained FROM brain_items item WHERE id=$1",
      [itemId],
    );
    expect(
      (
        await fixture.pool.query(
          "SELECT to_regclass('agent_memory_embeddings') AS cache",
        )
      ).rows,
    ).toEqual([{ cache: null }]);
    await migrate(fixture.db, { migrationsFolder: brain, migrationsTable });
    await migrate(fixture.db, { migrationsFolder: brain, migrationsTable });
    expect(
      (
        await fixture.pool.query(
          "SELECT to_jsonb(item) AS retained FROM brain_items item WHERE id=$1",
          [itemId],
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS entries FROM agent_memory_embeddings",
        )
      ).rows,
    ).toEqual([{ entries: 0 }]);
  } finally {
    await rm(previous, { recursive: true, force: true });
    await fixture.stop();
  }
}, 180_000);
