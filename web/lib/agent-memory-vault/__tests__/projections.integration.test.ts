import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { VaultAccess, VaultApplied } from "../store";

import { afterAll, beforeAll, expect, it } from "vitest";

import { parseAgentMemoryMutation } from "../commands";
import { listMemoryBacklinks, listMemoryTags } from "../index-queries";
import { reindexLegacyVaultHeads } from "../index-backfill";
import { agentMemoryVaultLimits } from "../limits";
import { searchMemory } from "../search";
import { applyVaultMutation } from "../store";

import { seedProject } from "@/test-support/execution-host-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

let fixture: StartedPostgresTestDb;
let access: VaultAccess;

beforeAll(async () => {
  fixture = await startMainPostgresTestDb({ databaseName: "memory_structure" });
  const projectId = await seedProject(fixture.db);
  const { rows } = await fixture.pool.query<{ id: string }>(
    "INSERT INTO agent_memory_vaults(project_id,agent_id) VALUES ($1,'fixture:structure') RETURNING id",
    [projectId],
  );

  access = {
    vaultId: rows[0]!.id,
    actor: { kind: "human", userId: "author" },
    principalKey: "user:author",
    sourceProjectIds: [projectId],
    sourceRestrictions: [],
    writeAdmission: "apply",
    canRead: async () => true,
    capture: async () => {},
  };
}, 180_000);
afterAll(async () => fixture?.stop());

async function apply(input: Record<string, unknown>) {
  return applyVaultMutation(
    fixture.db,
    parseAgentMemoryMutation(input),
    async () => access,
    agentMemoryVaultLimits(),
  );
}

async function create(
  path: string,
  file_text: string,
  requestKey: string,
): Promise<VaultApplied> {
  const result = await apply({
    command: "create",
    path,
    file_text,
    requestKey,
    ifRevisionId: null,
    ifHash: null,
  });

  if (result.status !== "applied")
    throw new Error("Expected fixture write to apply");

  return result;
}

it("AV-09 commits projections with their exact head, updates alias resolution and hides inaccessible contributors", async () => {
  const original = "/memories/notes/setup.md";
  const renamed = "/memories/notes/deploy.md";
  const source = "/memories/index.md";
  const target = (
    await create(
      original,
      "---\naliases: [Run guide]\n---\n# First deploy",
      "set-target",
    )
  ).affected[0]!;
  const note = (
    await create(
      source,
      "---\ntags: [ops]\n---\n[[notes/setup#First deploy]] [[Run guide]] [[hidden]] [[unknown]]",
      "set-source",
    )
  ).affected[0]!;
  const other = (
    await create(
      "/memories/notes/hidden.md",
      "---\ntags: [ops, private]\n---\nInternal",
      "set-secret",
    )
  ).affected[0]!;
  const readable = {
    ...access,
    canRead: async (_db: unknown, revision: { id: string }) =>
      revision.id !== other.revisionId,
  };

  expect(
    await listMemoryTags(fixture.db, { limit: 20 }, async () => readable),
  ).toEqual({
    items: [{ tag: "ops", count: 1 }],
    nextCursor: null,
  });
  expect(
    await listMemoryBacklinks(
      fixture.db,
      { path: original, limit: 20 },
      async () => readable,
    ),
  ).toEqual({
    items: [{ path: source, noteId: note.noteId, revisionId: note.revisionId }],
    nextCursor: null,
  });
  await apply({
    command: "rename",
    old_path: original,
    new_path: renamed,
    ifRevisionId: target.revisionId,
    ifHash: target.hash,
    requestKey: "rename-target",
  });
  const { rows } = await fixture.pool.query(
    `SELECT raw,state FROM agent_memory_note_links WHERE source_revision_id=$1 ORDER BY raw COLLATE "C"`,
    [note.revisionId],
  );

  expect(rows).toEqual([
    { raw: "Run guide", state: "resolved" },
    { raw: "hidden", state: "resolved" },
    { raw: "notes/setup#First deploy", state: "unresolved" },
    { raw: "unknown", state: "unresolved" },
  ]);
  expect(
    (
      await listMemoryBacklinks(
        fixture.db,
        { path: source, limit: 20, includeStructure: true },
        async () => readable,
      )
    ).structure,
  ).toMatchObject({
    links: [
      { raw: "Run guide", notePath: renamed },
      { raw: "hidden", notePath: null, href: null },
      { raw: "notes/setup#First deploy", notePath: null, href: null },
      { raw: "unknown", notePath: null, href: null },
    ],
  });
  await expect(
    apply({
      command: "create",
      path: source,
      file_text: "---\ntags: &bad [ops]\n---\nChanged",
      ifRevisionId: note.revisionId,
      ifHash: note.hash,
      requestKey: "invalid-edit",
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
  const exact = await fixture.pool.query(
    `SELECT h.head_revision_id, i.revision_id
     FROM agent_memory_notes h JOIN agent_memory_note_index i USING (vault_id)
     WHERE h.id=i.note_id AND h.id=$1`,
    [note.noteId],
  );

  expect(exact.rows).toEqual([
    { head_revision_id: note.revisionId, revision_id: note.revisionId },
  ]);
  await fixture.pool.query(
    "DELETE FROM agent_memory_note_index WHERE vault_id=$1",
    [access.vaultId],
  );
  expect(await reindexLegacyVaultHeads(fixture.db)).toBe(3);
  expect(await reindexLegacyVaultHeads(fixture.db)).toBe(0);
  expect(
    await listMemoryBacklinks(
      fixture.db,
      { path: renamed, limit: 20 },
      async () => readable,
    ),
  ).toMatchObject({
    items: [{ noteId: note.noteId, revisionId: note.revisionId }],
  });

  const oldPath = "/memories/notes/deploy.md";
  const movedPath = "/memories/notes/final.md";
  const current = (
    await fixture.pool.query<{ head_revision_id: string }>(
      "SELECT head_revision_id FROM agent_memory_notes WHERE id=$1",
      [target.noteId],
    )
  ).rows[0]!;
  const [moved, referrer] = await Promise.all([
    apply({
      command: "rename",
      old_path: oldPath,
      new_path: movedPath,
      ifRevisionId: current.head_revision_id,
      ifHash: target.hash,
      requestKey: "concurrent-rename",
    }),
    create("/memories/notes/referrer.md", "[[Run guide]]", "concurrent-create"),
  ]);

  expect(moved.status).toBe("applied");
  expect(
    await listMemoryBacklinks(
      fixture.db,
      { path: movedPath, limit: 20 },
      async () => readable,
    ),
  ).toMatchObject({
    items: [{ noteId: note.noteId }, { noteId: referrer.affected[0]!.noteId }],
  });
});

it("AV-09 ranks only visible current heads and finds English and Russian inflections on main-only Postgres", async () => {
  const visible = (
    await create(
      "/memories/notes/visible.md",
      "---\ntags: [triage]\n---\nInvestigating сбои",
      "search-visible",
    )
  ).affected[0]!;
  const hidden = (
    await create(
      "/memories/notes/secret.md",
      "---\ntags: [triage]\n---\nInvestigating investigating расследование",
      "search-hidden",
    )
  ).affected[0]!;
  const captured: string[] = [];
  const reader = {
    ...access,
    canRead: async (_tx: unknown, revision: { id: string }) =>
      revision.id !== hidden.revisionId,
    capture: async (_tx: unknown, revisions: readonly { id: string }[]) => {
      captured.push(...revisions.map(({ id }) => id));
    },
  };
  const prepare = async () => reader;

  for (const q of ["investigate", "сбой", ""]) {
    expect(
      await searchMemory(
        fixture.db,
        { q, tag: "triage", mode: "lexical", limit: 1 },
        prepare,
      ),
    ).toMatchObject({
      hits: [{ revisionId: visible.revisionId }],
      nextCursor: null,
    });
  }
  expect(captured).toEqual(Array.from({ length: 3 }, () => visible.revisionId));
  await apply({
    command: "delete",
    path: visible.path,
    ifRevisionId: visible.revisionId,
    ifHash: visible.hash,
    requestKey: "search-delete",
  });
  expect(
    await searchMemory(
      fixture.db,
      { q: "investigate", mode: "lexical", limit: 1 },
      prepare,
    ),
  ).toEqual({ hits: [], nextCursor: null });
});
