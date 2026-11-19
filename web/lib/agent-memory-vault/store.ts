import "server-only";

import type { AgentMemoryMutation } from "./commands";
import type { AgentMemoryLimits } from "./limits";
import type { VaultPending } from "./proposals";
import type { AgentMemoryAuthor, AgentMemoryRestriction } from "./types";
import type { Db } from "@/lib/execution-host/db";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { insertMemoryText, replaceMemoryText } from "./commands";
import { indexMemoryRevision, resolveIndexedMemoryLinks } from "./indexes";
import {
  isUnderMemoryPath,
  memoryNotePath,
  MEMORY_INDEX,
  MEMORY_ROOT,
} from "./paths";
import {
  findVaultProposal,
  retainVaultProposal,
  vaultProposalBases,
} from "./proposals";
import { parseMemoryStructure } from "./structure";

import {
  agentMemoryNotes as notes,
  agentMemoryOperations as operations,
  agentMemoryOperationRevisions as operationRevisions,
  agentMemoryRevisionPayloads as payloads,
  agentMemoryRevisions as revisions,
  agentMemoryVaults as vaults,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-memory-vault",
  level: process.env.LOG_LEVEL ?? "info",
});

export type VaultRevision = typeof revisions.$inferSelect;
export type Vault = typeof vaults.$inferSelect;

type Head = Readonly<{
  note: typeof notes.$inferSelect;
  revision: VaultRevision;
}>;
type HeadPrecondition = Readonly<{
  ifRevisionId: string | null;
  ifHash: string | null;
}>;
type TreeMutation = Extract<AgentMemoryMutation, { ifGeneration: string }>;
type EffectiveChange =
  | Readonly<{
      kind: "created";
      path: string;
      content: string;
      head: null;
      inherited: readonly VaultRevision[];
    }>
  | Readonly<{
      kind: "edited" | "renamed" | "deleted" | "reverted";
      path: string;
      content: string | null;
      head: Head;
      inherited: readonly VaultRevision[];
    }>;
type RedactedHead = Readonly<{
  kind: "redacted";
  path: string;
  content: null;
  head: Head;
  inherited: readonly VaultRevision[];
}>;

export type VaultAccess = Readonly<{
  vaultId: string;
  principalKey: string;
  actor: AgentMemoryAuthor;
  sourceProjectIds: readonly string[];
  sourceRestrictions: readonly AgentMemoryRestriction[];
  writeAdmission: "apply" | "review_required";
  visibleGeneration?: true;
  resolveLinkSources?: (
    db: Db,
    content: string,
  ) => Promise<
    Readonly<{
      projectIds: readonly string[];
      restrictions: readonly AgentMemoryRestriction[];
    }>
  >;
  canRead: (db: Db, revision: VaultRevision) => Promise<boolean>;
  capture: (db: Db, revisions: readonly VaultRevision[]) => Promise<void>;
}>;

export type PrepareVaultAccess = (db: Db) => Promise<VaultAccess>;

type AffectedRevision = Readonly<{
  noteId: string;
  revisionId: string;
  path: string;
  hash: string | null;
}>;

export type VaultApplied = Readonly<{
  status: "applied";
  operationId: string;
  affected: readonly AffectedRevision[];
}>;

export type VaultConflict = Readonly<{
  status: "conflict";
  current?: AffectedRevision & Readonly<{ content: string }>;
  mismatches?: readonly Readonly<{
    path: string;
    ifRevisionId: string;
    ifHash: string;
  }>[];
}>;

export type VaultMutationResult = VaultApplied | VaultConflict | VaultPending;

export function unavailableMemory(): MaisterError {
  return new MaisterError("PRECONDITION", "Resource unavailable", {
    details: { reason: "agent_memory_unavailable" },
  });
}

function unsafeRevision(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Agent memory revision has no available content",
  );
}

export async function lockVault(db: Db, vaultId: string): Promise<Vault> {
  const [vault] = await db
    .select()
    .from(vaults)
    .where(eq(vaults.id, vaultId))
    .for("update");

  if (!vault) throw unavailableMemory();

  return vault;
}

export async function loadActiveHeads(
  db: Db,
  vaultId: string,
): Promise<Head[]> {
  return db
    .select({ note: notes, revision: revisions })
    .from(notes)
    .innerJoin(
      revisions,
      and(
        eq(notes.vaultId, revisions.vaultId),
        eq(notes.id, revisions.noteId),
        eq(notes.headRevisionId, revisions.id),
      ),
    )
    .where(and(eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))
    .orderBy(notes.id);
}

async function readHead(
  db: Db,
  vaultId: string,
  noteId: string,
): Promise<Head> {
  const [head] = await db
    .select({ note: notes, revision: revisions })
    .from(notes)
    .innerJoin(
      revisions,
      and(
        eq(notes.vaultId, revisions.vaultId),
        eq(notes.id, revisions.noteId),
        eq(notes.headRevisionId, revisions.id),
      ),
    )
    .where(and(eq(notes.vaultId, vaultId), eq(notes.id, noteId)));

  if (!head) throw unavailableMemory();

  return head;
}

export async function readVaultRevision(
  db: Db,
  vaultId: string,
  noteId: string,
  revisionId: string,
): Promise<VaultRevision> {
  const [revision] = await db
    .select()
    .from(revisions)
    .where(
      and(
        eq(revisions.vaultId, vaultId),
        eq(revisions.noteId, noteId),
        eq(revisions.id, revisionId),
      ),
    );

  if (!revision) throw unavailableMemory();

  return revision;
}

export async function readVaultPayload(
  db: Db,
  revision: VaultRevision,
): Promise<string> {
  const [payload] = await db
    .select({ content: payloads.content })
    .from(payloads)
    .where(
      and(
        eq(payloads.vaultId, revision.vaultId),
        eq(payloads.noteId, revision.noteId),
        eq(payloads.revisionId, revision.id),
      ),
    );

  if (!payload) throw unsafeRevision();

  return payload.content;
}

async function requireRevisionRead(
  db: Db,
  access: VaultAccess,
  revision: VaultRevision,
) {
  if (!(await access.canRead(db, revision))) throw unavailableMemory();
}

function serializeRevision(revision: VaultRevision): AffectedRevision {
  return {
    noteId: revision.noteId,
    revisionId: revision.id,
    hash: revision.contentSha256,
    path: revision.path,
  };
}

function sameHead(head: Head | undefined, expected: HeadPrecondition): boolean {
  return (
    (head?.revision.id ?? null) === expected.ifRevisionId &&
    (head?.revision.contentSha256 ?? null) === expected.ifHash
  );
}

async function singleConflict(
  db: Db,
  access: VaultAccess,
  head: Head | undefined,
): Promise<VaultConflict> {
  if (!head) return { status: "conflict" };
  await requireRevisionRead(db, access, head.revision);
  if (head.revision.contentSha256 === null) return { status: "conflict" };
  const content = await readVaultPayload(db, head.revision);

  await access.capture(db, [head.revision]);

  return {
    status: "conflict",
    current: { ...serializeRevision(head.revision), content },
  };
}

async function checkPaths(
  db: Db,
  access: VaultAccess,
  active: readonly Head[],
  changes: readonly EffectiveChange[],
): Promise<void> {
  const touched = new Set(changes.map((change) => change.head?.note.id));
  const destinations = changes
    .filter((change) => change.content !== null)
    .map((change) => change.path);
  const remaining = active.filter((head) => !touched.has(head.note.id));
  const collisions = remaining.filter(({ note }) =>
    destinations.some(
      (path) =>
        note.path === path ||
        isUnderMemoryPath(note.path, path) ||
        isUnderMemoryPath(path, note.path),
    ),
  );

  for (const collision of collisions)
    await requireRevisionRead(db, access, collision.revision);
  if (collisions.length > 0)
    throw new MaisterError("CONFLICT", "Memory destination is occupied");
  const known = new Set(destinations);

  if (known.size !== destinations.length)
    throw new MaisterError(
      "CONFIG",
      "Memory command has duplicate destinations",
    );

  for (const path of destinations) {
    const components = path.split("/");

    for (let index = 3; index < components.length; index++) {
      if (known.has(components.slice(0, index).join("/")))
        throw new MaisterError(
          "CONFLICT",
          "Memory destination conflicts with a file or directory",
        );
    }
  }
}

function assertQuota(
  current: number,
  next: number,
  cap: number,
  message: string,
): void {
  if (next > cap && next > current) throw new MaisterError("CONFIG", message);
}

function quotaAfter(
  vault: Vault,
  changes: readonly EffectiveChange[],
  limits: AgentMemoryLimits,
): Readonly<{ chars: number; bytes: number; count: number }> {
  let chars = vault.contentChars;
  let bytes = vault.contentBytes;
  let count = vault.noteCount;

  for (const change of changes) {
    const prior = change.head?.revision;
    const size = change.content?.length ?? 0;
    const cap =
      change.path === MEMORY_INDEX ? limits.indexChars : limits.noteChars;
    const originalCap =
      change.head?.note.path === MEMORY_INDEX
        ? limits.indexChars
        : limits.noteChars;

    if (change.content !== null)
      assertQuota(
        originalCap === cap ? (prior?.sizeChars ?? 0) : 0,
        size,
        cap,
        "Memory note exceeds its character limit",
      );
    chars += size - (prior?.sizeChars ?? 0);
    bytes +=
      (change.content === null
        ? 0
        : Buffer.byteLength(change.content, "utf8")) - (prior?.sizeBytes ?? 0);
    count +=
      Number(change.content !== null) - Number(prior?.contentSha256 != null);
  }
  assertQuota(
    vault.contentChars,
    chars,
    limits.vaultChars,
    "Memory vault exceeds its character limit",
  );
  assertQuota(
    vault.noteCount,
    count,
    limits.notes,
    "Memory vault exceeds its note limit",
  );

  return { chars, bytes, count };
}

function classifyTree(command: TreeMutation, active: readonly Head[]): Head[] {
  if (command.command === "clear") return [...active];
  const prefix = command.command === "delete" ? command.path : command.old_path;

  return active.filter((head) => isUnderMemoryPath(prefix, head.note.path));
}

export async function visibleVaultDirectory(
  db: Db,
  access: VaultAccess,
  vault: Vault,
  path: string,
  revisions: readonly VaultRevision[],
) {
  const visible: VaultRevision[] = [];
  for (const revision of revisions)
    if (
      isUnderMemoryPath(path, revision.path) &&
      (await access.canRead(db, revision))
    )
      visible.push(revision);
  if (!access.visibleGeneration)
    return { visible, generation: String(vault.generation) };
  // The public generation codec accepts a decimal 64-bit identifier.
  const digest = createHash("sha256")
    .update(
      canonicalCommandJson(
        visible
          .map((revision) => [revision.id, revision.path])
          .sort((left, right) => left[0]!.localeCompare(right[0]!)),
      ),
    )
    .digest("hex");

  return { visible, generation: BigInt(`0x${digest.slice(0, 15)}`).toString() };
}

async function planTree(
  db: Db,
  access: VaultAccess,
  vault: Vault,
  command: TreeMutation,
  active: readonly Head[],
): Promise<readonly EffectiveChange[] | VaultConflict> {
  const targets = classifyTree(command, active);

  for (const target of targets)
    await requireRevisionRead(db, access, target.revision);
  const expected = new Map(command.heads.map((head) => [head.path, head]));
  const mismatches = targets.filter((head) => {
    const precondition = expected.get(head.note.path);

    return !precondition || !sameHead(head, precondition);
  });

  const directory =
    command.command === "rename"
      ? command.old_path
      : command.command === "clear"
        ? MEMORY_ROOT
        : command.path;
  const { generation } = await visibleVaultDirectory(
    db,
    access,
    vault,
    directory,
    targets.map(({ revision }) => revision),
  );
  if (
    generation !== command.ifGeneration ||
    expected.size !== command.heads.length ||
    targets.length !== expected.size ||
    mismatches.length > 0
  ) {
    await access.capture(
      db,
      mismatches.map(({ revision }) => revision),
    );

    return {
      status: "conflict",
      mismatches: mismatches.map(({ revision }) => ({
        path: revision.path,
        ifRevisionId: revision.id,
        ifHash: revision.contentSha256!,
      })),
    };
  }
  if (command.command !== "rename")
    return targets.map((head) => ({
      kind: "deleted",
      path: head.note.path,
      content: null,
      head,
      inherited: [head.revision],
    }));
  if (
    command.new_path === command.old_path ||
    isUnderMemoryPath(command.old_path, command.new_path) ||
    isUnderMemoryPath(command.new_path, command.old_path)
  )
    throw new MaisterError(
      "CONFIG",
      "Memory directory rename requires a disjoint destination",
    );
  const occupied = active.filter(({ note }) =>
    isUnderMemoryPath(command.new_path, note.path),
  );
  for (const item of occupied)
    await requireRevisionRead(db, access, item.revision);
  if (occupied.length > 0)
    throw new MaisterError(
      "CONFLICT",
      "Memory destination directory is occupied",
    );

  return Promise.all(
    targets.map(async (head) => ({
      kind: "renamed" as const,
      path: memoryNotePath(
        command.new_path + head.note.path.slice(command.old_path.length),
      ),
      content: await readVaultPayload(db, head.revision),
      head,
      inherited: [head.revision],
    })),
  );
}

async function planOne(
  db: Db,
  access: VaultAccess,
  command: Exclude<AgentMemoryMutation, { ifGeneration: string }>,
  active: readonly Head[],
): Promise<readonly EffectiveChange[] | VaultConflict> {
  const head =
    command.command === "revert"
      ? await readHead(db, access.vaultId, command.noteId)
      : active.find(
          ({ note }) =>
            note.path ===
            (command.command === "rename" ? command.old_path : command.path),
        );

  if (!sameHead(head, command)) return singleConflict(db, access, head);
  if (!head && command.command === "create")
    return [
      {
        kind: "created",
        path: command.path,
        content: command.file_text,
        head: null,
        inherited: [],
      },
    ];
  if (!head) throw unavailableMemory();
  await requireRevisionRead(db, access, head.revision);
  const inherited = [head.revision];

  if (command.command === "delete")
    return [
      { kind: "deleted", path: head.note.path, content: null, head, inherited },
    ];
  if (command.command === "revert") {
    const target = await readVaultRevision(
      db,
      access.vaultId,
      command.noteId,
      command.revisionId,
    );

    await requireRevisionRead(db, access, target);
    const content = await readVaultPayload(db, target);

    return [
      {
        kind: "reverted",
        path: head.note.path,
        content,
        head,
        inherited: [...inherited, target],
      },
    ];
  }
  if (command.command === "create")
    return [
      {
        kind: "edited",
        path: head.note.path,
        content: command.file_text,
        head,
        inherited,
      },
    ];
  const before = await readVaultPayload(db, head.revision);

  switch (command.command) {
    case "rename":
      if (command.new_path === command.old_path)
        throw new MaisterError(
          "CONFIG",
          "Memory destination must differ from the source",
        );

      return [
        {
          kind: "renamed",
          path: command.new_path,
          content: before,
          head,
          inherited,
        },
      ];
    case "str_replace":
      return [
        {
          kind: "edited",
          path: head.note.path,
          content: replaceMemoryText(before, command.old_str, command.new_str),
          head,
          inherited,
        },
      ];
    case "insert":
      return [
        {
          kind: "edited",
          path: head.note.path,
          content: insertMemoryText(
            before,
            command.insert_line,
            command.insert_text,
          ),
          head,
          inherited,
        },
      ];
  }
}

async function retentionSources(
  db: Db,
  access: VaultAccess,
  inherited: readonly VaultRevision[],
  contents: readonly (string | null)[],
) {
  const derived = [];
  for (const content of contents)
    if (content !== null && access.resolveLinkSources)
      derived.push(await access.resolveLinkSources(db, content));
  const projectIds = [
    ...new Set([
      ...access.sourceProjectIds,
      ...derived.flatMap((source) => source.projectIds),
      ...inherited.flatMap((item) => item.sourceProjectIds),
    ]),
  ].sort();
  const byKey = new Map(
    [
      ...access.sourceRestrictions,
      ...derived.flatMap((source) => source.restrictions),
      ...inherited.flatMap((item) => item.sourceRestrictions),
    ].map((restriction) => [canonicalCommandJson(restriction), restriction]),
  );
  const restrictions = [...byKey]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, restriction]) => restriction);

  if (
    projectIds.length > 256 ||
    restrictions.length > 256 ||
    Buffer.byteLength(JSON.stringify(restrictions)) > 65536
  )
    throw new MaisterError(
      "PRECONDITION",
      "Vault source capture exceeds its bound",
    );

  return { projectIds, restrictions };
}

async function recordChange(
  db: Db,
  access: VaultAccess,
  operationId: string,
  ordinal: number,
  change: EffectiveChange | RedactedHead,
): Promise<VaultRevision> {
  const noteId = change.head?.note.id ?? randomUUID();
  const revisionId = randomUUID();
  const sources = await retentionSources(db, access, change.inherited, [
    change.content,
  ]);
  const { content } = change;

  if (change.head === null)
    await db.insert(notes).values({
      id: noteId,
      vaultId: access.vaultId,
      path: change.path,
      headRevisionId: revisionId,
    });
  const [record] = await db
    .insert(revisions)
    .values({
      id: revisionId,
      vaultId: access.vaultId,
      noteId,
      parentRevisionId: change.head?.revision.id,
      operationId,
      path: change.path,
      kind: change.kind,
      contentSha256:
        content === null
          ? null
          : createHash("sha256").update(content).digest("hex"),
      sizeChars: content?.length ?? 0,
      sizeBytes: content === null ? 0 : Buffer.byteLength(content),
      author: access.actor,
      sourceProjectIds: sources.projectIds,
      sourceRestrictions: sources.restrictions,
    })
    .returning();

  if (!record)
    throw new MaisterError("CRASH", "Vault revision was not recorded");
  if (content !== null)
    await db
      .insert(payloads)
      .values({ vaultId: access.vaultId, noteId, revisionId, content });
  await indexMemoryRevision(
    db,
    record,
    content,
    access.actor.kind === "operator_import" || change.kind === "renamed"
      ? "retain-legacy"
      : "validate",
  );
  if (change.head !== null) {
    await db
      .update(notes)
      .set({
        path: change.path,
        headRevisionId: revisionId,
        deletedAt: content === null ? sql`now()` : null,
      })
      .where(and(eq(notes.vaultId, access.vaultId), eq(notes.id, noteId)));
    await db.insert(operationRevisions).values({
      vaultId: access.vaultId,
      operationId,
      ordinal,
      noteId,
      revisionId: change.head.revision.id,
      role: "base",
    });
  }
  await db.insert(operationRevisions).values({
    vaultId: access.vaultId,
    operationId,
    ordinal,
    noteId,
    revisionId,
    role: "result",
  });

  return record;
}

export async function tombstoneRedactedHead(
  tx: Db,
  vault: Vault,
  revision: VaultRevision,
  userId: string,
  redactionId: string,
): Promise<void> {
  const head = await readHead(tx, vault.id, revision.noteId);
  if (head.revision.id !== revision.id) return;
  const operationId = randomUUID();

  await tx.insert(operations).values({
    id: operationId,
    vaultId: vault.id,
    principalKey: `redaction:${userId}`,
    commandKind: "redact",
    requestKey: redactionId,
    commandDigest: createHash("sha256").update(revision.id).digest("hex"),
    outcome: "applied",
  });
  await recordChange(
    tx,
    {
      vaultId: vault.id,
      principalKey: `user:${userId}`,
      actor: { kind: "human", userId },
      sourceProjectIds: revision.sourceProjectIds,
      sourceRestrictions: revision.sourceRestrictions,
      writeAdmission: "apply",
      canRead: async () => true,
      capture: async () => {},
    },
    operationId,
    0,
    {
      kind: "redacted",
      path: head.note.path,
      content: null,
      head,
      inherited: [revision],
    },
  );
  await resolveIndexedMemoryLinks(tx, vault.id);
  await tx
    .update(vaults)
    .set({
      generation: vault.generation + 1n,
      noteCount: vault.noteCount - 1,
      contentBytes: vault.contentBytes - revision.sizeBytes,
      contentChars: vault.contentChars - revision.sizeChars,
    })
    .where(eq(vaults.id, vault.id));
}

async function replay(
  db: Db,
  access: VaultAccess,
  operation: typeof operations.$inferSelect,
  digest: string,
): Promise<VaultApplied | VaultPending> {
  if (operation.outcome === "pending") {
    const proposal = await findVaultProposal(db, access.vaultId, operation.id);
    if (!proposal || proposal.state === "redacted") throw unavailableMemory();
    const bases = await vaultProposalBases(db, access.vaultId, operation.id);

    for (const revision of bases)
      await requireRevisionRead(db, access, revision);
    if (operation.commandDigest !== digest)
      throw new MaisterError(
        "CONFLICT",
        "Memory request key already belongs to a different command",
      );
    await access.capture(db, bases);

    return {
      status: "pending",
      operationId: operation.id,
      proposalId: proposal.id,
    };
  }
  const rows = await db
    .select({ revision: revisions })
    .from(operationRevisions)
    .innerJoin(
      revisions,
      and(
        eq(operationRevisions.vaultId, revisions.vaultId),
        eq(operationRevisions.noteId, revisions.noteId),
        eq(operationRevisions.revisionId, revisions.id),
      ),
    )
    .where(
      and(
        eq(operationRevisions.vaultId, access.vaultId),
        eq(operationRevisions.operationId, operation.id),
        eq(operationRevisions.role, "result"),
      ),
    )
    .orderBy(operationRevisions.ordinal);
  const results = rows.map((row) => row.revision);

  for (const revision of results) {
    await requireRevisionRead(db, access, revision);
    if (revision.contentSha256 !== null) await readVaultPayload(db, revision);
  }
  if (operation.commandDigest !== digest)
    throw new MaisterError(
      "CONFLICT",
      "Memory request key already belongs to a different command",
    );
  await access.capture(db, results);

  return {
    status: "applied",
    operationId: operation.id,
    affected: results.map(serializeRevision),
  };
}

/** Inspect the exact plan under the same preconditions as a future owner-confirmed edit. */
export async function previewVaultMutation(
  tx: Db,
  access: VaultAccess,
  command: AgentMemoryMutation,
) {
  const vault = await lockVault(tx, access.vaultId);
  const active = await loadActiveHeads(tx, vault.id);
  const plan =
    "ifGeneration" in command
      ? await planTree(tx, access, vault, command, active)
      : await planOne(tx, access, command, active);
  if ("status" in plan)
    throw new MaisterError("CONFLICT", "Memory changed before confirmation");
  await checkPaths(tx, access, active, plan);
  const sources = await retentionSources(
    tx,
    access,
    plan.flatMap(({ inherited }) => inherited),
    plan.map(({ content }) => content),
  );
  const preview = await Promise.all(
    plan.map(async (step) => {
      const base = step.head?.revision;
      const before = base?.contentSha256
        ? await readVaultPayload(tx, base)
        : null;
      const after = step.content;

      return {
        path: step.path,
        revisionId: base?.id ?? null,
        beforeSha256: base?.contentSha256 ?? null,
        afterSha256:
          after === null
            ? null
            : createHash("sha256").update(after).digest("hex"),
        before: before?.slice(0, 2048) ?? null,
        after: after?.slice(0, 2048) ?? null,
      };
    }),
  );
  const dependencies = [
    ...new Map(
      plan
        .flatMap(({ inherited }) => inherited)
        .map((revision) => [revision.id, revision]),
    ).values(),
  ].flatMap((revision) =>
    revision.contentSha256
      ? [
          {
            kind: "agent_vault_revision_v1" as const,
            vaultId: revision.vaultId,
            noteId: revision.noteId,
            revisionId: revision.id,
            contentSha256: revision.contentSha256,
          },
        ]
      : [],
  );

  return { sources, preview, dependencies };
}

export async function applyVaultMutationInTransaction(
  db: Db,
  command: AgentMemoryMutation,
  prepare: PrepareVaultAccess,
  limits: AgentMemoryLimits,
): Promise<VaultMutationResult> {
  const access = await prepare(db);
  const vault = await lockVault(db, access.vaultId);
  const digest = createHash("sha256")
    .update(canonicalCommandJson(command))
    .digest("hex");
  const [existing] = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.vaultId, vault.id),
        eq(operations.principalKey, access.principalKey),
        eq(operations.requestKey, command.requestKey),
      ),
    );

  if (existing) return replay(db, access, existing, digest);
  const active = await loadActiveHeads(db, vault.id);
  const plan =
    "ifGeneration" in command
      ? await planTree(db, access, vault, command, active)
      : await planOne(db, access, command, active);

  if ("status" in plan) return plan;
  const affectedNotes = plan.flatMap(({ head }) =>
    head === null ? [] : [head.note.id],
  );

  if (affectedNotes.length > 0) {
    await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.vaultId, vault.id), inArray(notes.id, affectedNotes)))
      .orderBy(notes.id)
      .for("update");
  }
  await checkPaths(db, access, active, plan);
  const quota = quotaAfter(vault, plan, limits);
  const operationId = randomUUID();

  if (access.writeAdmission === "review_required") {
    const bases = [
      ...new Map(
        plan
          .flatMap((change) => change.inherited)
          .map((revision) => [revision.id, revision]),
      ).values(),
    ];
    const sources = await retentionSources(
      db,
      access,
      bases,
      plan.map(({ content }) => content),
    );
    const changes = plan.map((change) => {
      if (change.content !== null && change.kind !== "renamed")
        parseMemoryStructure(change.content);

      return {
        kind: change.kind,
        path: change.path,
        beforeRevisionId: change.head?.revision.id ?? null,
        afterHash:
          change.content === null
            ? null
            : createHash("sha256").update(change.content).digest("hex"),
      };
    });

    return retainVaultProposal(db, {
      operationId,
      digest,
      command,
      changes,
      sourceProjectIds: sources.projectIds,
      sourceRestrictions: sources.restrictions,
      refs: bases,
      access,
      maxPending: limits.pending,
    });
  }

  await db.insert(operations).values({
    id: operationId,
    vaultId: vault.id,
    principalKey: access.principalKey,
    requestKey: command.requestKey,
    commandKind: command.command,
    commandDigest: digest,
    outcome: "applied",
  });
  const results: VaultRevision[] = [];

  for (const [ordinal, change] of plan.entries())
    results.push(await recordChange(db, access, operationId, ordinal, change));
  if (results.length > 0) {
    await resolveIndexedMemoryLinks(db, vault.id);
    await db
      .update(vaults)
      .set({
        generation: vault.generation + 1n,
        contentChars: quota.chars,
        contentBytes: quota.bytes,
        noteCount: quota.count,
      })
      .where(eq(vaults.id, vault.id));
  }
  await access.capture(db, results);

  return {
    status: "applied",
    operationId,
    affected: results.map(serializeRevision),
  };
}

export async function applyVaultMutation(
  db: Db,
  command: AgentMemoryMutation,
  prepare: PrepareVaultAccess,
  limits: AgentMemoryLimits,
): Promise<VaultMutationResult> {
  const start = performance.now();
  const result = await db.transaction((tx) =>
    applyVaultMutationInTransaction(tx, command, prepare, limits),
  );
  const metadata = {
    command: command.command,
    elapsedMs: performance.now() - start,
  };

  if (result.status === "applied")
    log.info(
      {
        ...metadata,
        operationId: result.operationId,
        revisions: result.affected.length,
      },
      "agent memory operation settled",
    );
  else if (result.status === "pending")
    log.info(
      {
        ...metadata,
        operationId: result.operationId,
        proposalId: result.proposalId,
      },
      "agent memory operation awaits review",
    );
  else log.warn(metadata, "agent memory compare-and-swap lost");
  log.debug(metadata, "agent memory mutation transaction returned");

  return result;
}
