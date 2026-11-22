import type { VaultAccess, VaultApplied, VaultMutationResult } from "../store";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { parseAgentMemoryMutation, parseAgentMemoryView } from "../commands";
import { vaultRevisionDetail } from "../history";
import { agentMemoryVaultLimits, MAX_PAGE_CHARS } from "../limits";
import { applyVaultMutation } from "../store";
import { viewAgentMemory, viewAgentNote } from "../view";
import { executionVaultWriteAdmission } from "../write-admission";

import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { recordKnowledgeDisclosure } from "@/lib/brain/knowledge-disclosure";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";

let fixture: StartedPostgresTestDb;
let projectId: string;
const limits = agentMemoryVaultLimits({});

beforeAll(async () => {
  fixture = await startMainPostgresTestDb({
    databaseName: "agent_memory_commands",
  });
  projectId = await seedProject(fixture.db);
}, 180_000);
afterAll(async () => fixture?.stop());

async function vault(agentId: string): Promise<VaultAccess> {
  const { rows } = await fixture.pool.query<{ id: string }>(
    "INSERT INTO agent_memory_vaults(project_id,agent_id) VALUES ($1,$2) RETURNING id",
    [projectId, agentId],
  );

  return {
    vaultId: rows[0]!.id,
    principalKey: "user:owner",
    actor: { kind: "human", userId: "owner" },
    sourceProjectIds: [projectId],
    sourceRestrictions: [],
    writeAdmission: "apply",
    canRead: async () => true,
    capture: async () => {},
  };
}

function apply(
  access: VaultAccess,
  input: Record<string, unknown>,
  bounds = limits,
): Promise<VaultMutationResult> {
  return applyVaultMutation(
    fixture.db,
    parseAgentMemoryMutation(input),
    async () => access,
    bounds,
  );
}

function create(path: string, text: string, requestKey: string) {
  return {
    command: "create",
    path,
    file_text: text,
    requestKey,
    ifRevisionId: null,
    ifHash: null,
  };
}

function applied(result: VaultMutationResult): VaultApplied {
  if (result.status !== "applied")
    throw new Error("Expected applied vault operation");

  return result;
}

it("AV-01 serializes one-line edits in a 20-note vault and preserves the other 19 heads", async () => {
  const access = await vault("fixture:races");
  const path = "/memories/notes/race.md";
  const head = applied(await apply(access, create(path, "old\n", "create-01")))
    .affected[0]!;

  for (let index = 0; index < 19; index++) {
    applied(
      await apply(
        access,
        create(
          `/memories/notes/untouched-${index}.md`,
          `Retained line ${index}\n`,
          `untouched-${index}`,
        ),
      ),
    );
  }
  const unaffected = () =>
    fixture.pool.query(
      `SELECT note.id,note.path,note.head_revision_id,revision.content_sha256
       FROM agent_memory_notes note JOIN agent_memory_revisions revision
         ON (revision.vault_id,revision.note_id,revision.id)=(note.vault_id,note.id,note.head_revision_id)
       WHERE note.vault_id=$1 AND note.id<>$2 ORDER BY note.path`,
      [access.vaultId, head.noteId],
    );
  const before = (await unaffected()).rows;

  expect(before).toHaveLength(19);
  const patch = {
    command: "str_replace",
    path,
    old_str: "old",
    new_str: "winner",
    ifHash: head.hash,
    ifRevisionId: head.revisionId,
    requestKey: "writer-01",
  };
  let releaseWinner!: () => void;
  let enteredCapture!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredCapture = resolve;
  });
  const first = apply(
    {
      ...access,
      capture: async () => {
        enteredCapture();
        await hold;
      },
    },
    patch,
  );

  await entered;
  const second = apply(access, {
    ...patch,
    new_str: "loser",
    requestKey: "writer-02",
  });

  try {
    await vi.waitFor(
      async () => {
        const { rows } = await fixture.pool.query<{ blocked: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'select%agent_memory_vaults%for update') AS blocked",
        );

        expect(rows[0]?.blocked).toBe(true);
      },
      { timeout: 4000 },
    );
  } finally {
    releaseWinner();
  }
  expect((await first).status).toBe("applied");
  expect(await second).toMatchObject({
    status: "conflict",
    current: { content: "winner\n", noteId: head.noteId },
  });
  const { rows } = await fixture.pool.query(
    "SELECT count(*)::int AS count FROM agent_memory_revisions WHERE note_id=$1",
    [head.noteId],
  );

  expect(rows).toEqual([{ count: 2 }]);
  expect((await unaffected()).rows).toEqual(before);
});

it("AV-12 replays once and denies collisions with targets the writer cannot see", async () => {
  const access = await vault("fixture:replays");
  const input = create("/memories/notes/hidden.md", "private", "create-01");
  const created = applied(await apply(access, input));

  expect(await apply(access, input)).toEqual(created);
  await expect(
    apply(access, { ...input, file_text: "changed" }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    apply(
      { ...access, canRead: async () => false },
      create("/memories/notes/hidden.md/child.md", "child", "create-02"),
    ),
  ).rejects.toMatchObject({ details: { reason: "agent_memory_unavailable" } });
  await expect(
    apply(
      { ...access, writeAdmission: "review_required" },
      create("/memories/notes/pending.md", "pending", "create-03"),
    ),
  ).resolves.toMatchObject({
    status: "pending",
  });
});

it("AV-01 independent notes use separate preconditions and contend only for the bounded vault quota", async () => {
  const access = await vault("fixture:quota");
  const writes = [
    create("/memories/notes/one.md", "one", "create-01"),
    create("/memories/notes/two.md", "two", "create-02"),
  ];
  const results = await Promise.all(
    writes.map((input) => apply(access, input)),
  );

  expect(results.map((result) => result.status)).toEqual([
    "applied",
    "applied",
  ]);

  const limited = await vault("fixture:limited");
  const limitedResults = await Promise.allSettled(
    writes.map((input) => apply(limited, input, { ...limits, notes: 1 })),
  );

  expect(limitedResults.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const { rows } = await fixture.pool.query(
    "SELECT note_count,content_chars FROM agent_memory_vaults WHERE id=$1",
    [limited.vaultId],
  );

  expect(rows).toEqual([{ note_count: 1, content_chars: 3 }]);
});

it("AV-01 K09 keeps the original note addressable after path reuse and restores it under CAS", async () => {
  const access = await vault("fixture:first-writer");
  const path = "/memories/notes/first.md";
  const attempts = await Promise.all([
    apply(access, create(path, "one", "create-01")),
    apply(access, create(path, "two", "create-02")),
  ]);
  const winner = attempts.find((result) => result.status === "applied");
  const loser = attempts.find((result) => result.status === "conflict");

  expect(winner?.affected).toHaveLength(1);
  const head = winner!.affected[0]!;

  expect(loser?.current?.revisionId).toBe(head.revisionId);

  const deletion = (requestKey: string) =>
    apply(access, {
      command: "delete",
      path,
      ifHash: head.hash,
      ifRevisionId: head.revisionId,
      requestKey,
    });
  const deletions = await Promise.all([
    deletion("delete-01"),
    deletion("delete-02"),
  ]);
  const tombstone = deletions.find((result) => result.status === "applied")
    ?.affected[0];

  expect(tombstone).toMatchObject({ noteId: head.noteId, hash: null });
  expect(deletions.find((result) => result.status === "conflict")).toEqual({
    status: "conflict",
  });
  const replacement = applied(
    await apply(access, create(path, "A different note", "reuse-path")),
  ).affected[0]!;

  expect(replacement.noteId).not.toBe(head.noteId);
  const historical = await vaultRevisionDetail(
    fixture.db,
    head.revisionId,
    async () => access,
    head.noteId,
  );

  expect(historical.revision).toMatchObject({
    noteId: head.noteId,
    path,
    state: "available",
  });
  await expect(
    viewAgentNote(fixture.db, { noteId: head.noteId }, async () => access),
  ).rejects.toMatchObject({ details: { reason: "agent_memory_unavailable" } });
  await expect(
    vaultRevisionDetail(
      fixture.db,
      head.revisionId,
      async () => access,
      replacement.noteId,
    ),
  ).rejects.toMatchObject({ details: { reason: "agent_memory_unavailable" } });
  applied(
    await apply(access, {
      command: "rename",
      old_path: path,
      new_path: "/memories/notes/replacement.md",
      ifRevisionId: replacement.revisionId,
      ifHash: replacement.hash,
      requestKey: "move-replacement",
    }),
  );
  const restored = applied(
    await apply(access, {
      command: "revert",
      noteId: head.noteId,
      revisionId: head.revisionId,
      ifRevisionId: tombstone?.revisionId,
      ifHash: null,
      requestKey: "revert-01",
    }),
  ).affected[0];

  expect(restored).toMatchObject({
    noteId: head.noteId,
    hash: head.hash,
    path,
  });
  expect(restored?.revisionId).not.toBe(head.revisionId);
  expect(
    await viewAgentNote(
      fixture.db,
      { noteId: head.noteId },
      async () => access,
    ),
  ).toMatchObject({
    noteId: head.noteId,
    revisionId: restored?.revisionId,
    path,
  });
  expect(
    await viewAgentNote(
      fixture.db,
      { noteId: replacement.noteId },
      async () => access,
    ),
  ).toMatchObject({ path: "/memories/notes/replacement.md" });
});

it("AV-01 directory rename and clear cannot both apply from the same generation", async () => {
  const access = await vault("fixture:directory");
  const prefix = "/memories/notes/archive";
  const paths = [`${prefix}/one.md`, `${prefix}/two.md`];
  const heads = [];

  for (const [index, path] of paths.entries()) {
    const head = applied(
      await apply(access, create(path, path, `create-${index}`)),
    ).affected[0]!;

    heads.push({ path, ifRevisionId: head.revisionId, ifHash: head.hash });
  }

  const expected = { heads, ifGeneration: "2" };
  const [rename, clear] = await Promise.all([
    apply(access, {
      command: "rename",
      old_path: prefix,
      new_path: "/memories/notes/renamed",
      requestKey: "rename-01",
      ...expected,
    }),
    apply(access, { command: "clear", requestKey: "clear-01", ...expected }),
  ]);

  expect([rename.status, clear.status].sort()).toEqual(["applied", "conflict"]);
  const { rows } = await fixture.pool.query(
    "SELECT generation::int, note_count FROM agent_memory_vaults WHERE id=$1",
    [access.vaultId],
  );

  expect(rows).toEqual([
    {
      generation: 3,
      note_count: rename.status === "applied" ? 2 : 0,
    },
  ]);
  if (rename.status === "applied") {
    expect(rename.affected.map((item) => item.path).sort()).toEqual([
      "/memories/notes/renamed/one.md",
      "/memories/notes/renamed/two.md",
    ]);
  }
});

it("AV-04 derives the review gate from the full server-owned execution lineage", async () => {
  const manual = await seedRun(fixture.db, { projectId });
  const webhook = await seedRun(fixture.db, { projectId });
  const child = await seedRun(fixture.db, { projectId, rootRunId: webhook });
  const retry = await seedRun(fixture.db, { projectId });
  const imported = await seedRun(fixture.db, { projectId });

  await fixture.pool.query(
    "UPDATE runs SET trigger_source='webhook' WHERE id=$1",
    [webhook],
  );
  await fixture.pool.query(
    "UPDATE runs SET trigger_source='manual', retry_of_run_id=$2 WHERE id=$1",
    [retry, child],
  );
  await fixture.pool.query(
    "UPDATE runs SET trigger_source='manual' WHERE id=$1",
    [manual],
  );
  await fixture.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES ('imported',$1,1,'Imported','Imported input')",
    [projectId],
  );
  await fixture.pool.query(
    `INSERT INTO task_external_sources
      (id,project_id,task_id,source_kind,source_instance,scope_key,external_id,origin,created_by_actor_type)
      VALUES ('external-source',$1,'imported','github','github.com','fixture/repo','42','import','system')`,
    [projectId],
  );
  await fixture.pool.query(
    "UPDATE runs SET trigger_source='manual', task_id='imported' WHERE id=$1",
    [imported],
  );

  await expect(executionVaultWriteAdmission(fixture.db, manual)).resolves.toBe(
    "apply",
  );
  for (const source of [webhook, child, retry, imported, "missing"]) {
    await expect(
      executionVaultWriteAdmission(fixture.db, source),
    ).resolves.toBe("review_required");
  }
});

it("AV-12 retains the exact revision in a versioned native capture and rechecks its source access", async () => {
  const agentId = "fixture:native";
  const access = await vault(agentId);
  const runId = await seedRun(fixture.db, { projectId });
  const userId = await seedActiveUser(fixture.db);

  await addProjectMember(fixture.db, { projectId, userId, role: "member" });
  await fixture.pool.query(
    `INSERT INTO agents (id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES ($1,'fixture','1','git','Memory test','','none','session','[]','read_only','agents/native.md')`,
    [agentId],
  );
  await fixture.pool.query(
    "INSERT INTO agent_project_links(id,project_id,agent_id,enabled,memory_enabled) VALUES ('memory-native-link',$1,$2,true,true)",
    [projectId, agentId],
  );
  const head = applied(
    await apply(
      access,
      create("/memories/notes/source.md", "first revision", "create-01"),
    ),
  ).affected[0]!;
  const restriction = {
    kind: "agent_vault_revision_v1" as const,
    vaultId: access.vaultId,
    noteId: head.noteId,
    revisionId: head.revisionId,
    contentSha256: head.hash!,
  };
  const principal = { kind: "user" as const, userId };
  const capture = {
    schemaVersion: 1 as const,
    state: "complete" as const,
    generation: 1,
    restrictions: [],
  };

  await fixture.db.transaction(async (tx) => {
    await authorizeSourceRestrictions(tx, principal, [restriction]);
    await recordKnowledgeDisclosure(tx, { runId, capture }, [restriction]);
  });
  const { rows } = await fixture.pool.query(
    "SELECT knowledge_access FROM runs WHERE id=$1",
    [runId],
  );

  expect(knowledgeAccessCaptureSchema.parse(rows[0]?.knowledge_access)).toEqual(
    {
      ...capture,
      schemaVersion: 2,
      generation: 2,
      restrictions: [restriction],
    },
  );
  await expect(
    fixture.db.transaction((tx) =>
      authorizeSourceRestrictions(tx, principal, [
        {
          ...restriction,
          contentSha256: "0".repeat(64),
        },
      ]),
    ),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
  await fixture.pool.query(
    "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
    [projectId, userId],
  );
  await expect(
    fixture.db.transaction((tx) =>
      authorizeSourceRestrictions(tx, principal, [restriction]),
    ),
  ).rejects.toMatchObject({
    details: { reason: "knowledge_reference_unavailable" },
  });
});

it("AV-02 records a single visible witness for a folder entry at the page boundary", async () => {
  const access = await vault("fixture:folder-paging");
  const paths = ["/memories/notes/first.md", "/memories/notes/second.md"];

  for (const [index, path] of paths.entries())
    applied(await apply(access, create(path, "", `folder-${index}`)));
  const capture = vi.fn<VaultAccess["capture"]>().mockResolvedValue(undefined);

  const page = await viewAgentMemory(
    fixture.db,
    parseAgentMemoryView({ command: "view", path: "/memories", limit: 1 }),
    async () => ({ ...access, capture }),
  );

  expect(page).toMatchObject({
    kind: "directory",
    entries: [{ kind: "directory", path: "/memories/notes" }],
    nextCursor: null,
  });
  expect(capture).toHaveBeenCalledOnce();
  const witnesses = capture.mock.calls[0]![1];

  expect(witnesses).toHaveLength(1);
  expect(paths).toContain(witnesses[0]?.path);
});

it("AV-12 pages a text body without splitting Unicode or replaying a cursor against a different principal or head", async () => {
  const access = await vault("fixture:paging");
  const path = "/memories/notes/long.md";
  const text = "a".repeat(MAX_PAGE_CHARS - 1) + "🎉" + " tail";
  const head = applied(await apply(access, create(path, text, "create-01")))
    .affected[0]!;
  const read = (reader: VaultAccess, cursor?: string) =>
    viewAgentMemory(
      fixture.db,
      parseAgentMemoryView({ command: "view", path, cursor }),
      async () => reader,
    );

  vi.stubEnv("AUTH_SECRET", "local-agent-memory-pagination-test-secret");
  try {
    const first = await read(access);

    expect(first.kind).toBe("note");
    if (first.kind !== "note" || !first.nextCursor)
      throw new Error("Expected a continuation for the Unicode note");
    const second = await read(access, first.nextCursor);

    expect(first.content.length).toBe(MAX_PAGE_CHARS - 1);
    expect(second).toMatchObject({ content: "🎉 tail", nextCursor: null });
    await expect(
      read({ ...access, principalKey: "user:other" }, first.nextCursor),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await apply(access, {
      ...create(path, "replacement", "replace-01"),
      ifHash: head.hash,
      ifRevisionId: head.revisionId,
    });
    await expect(read(access, first.nextCursor)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
