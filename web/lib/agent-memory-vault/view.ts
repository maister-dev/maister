import "server-only";

import type { AgentMemoryView } from "./commands";
import type { PrepareVaultAccess, VaultAccess, VaultRevision } from "./store";
import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";

import { z } from "zod";

import { MAX_NOTE_CHARS, MAX_PAGE_CHARS } from "./limits";
import { MEMORY_ROOT } from "./paths";
import {
  loadActiveHeads,
  lockVault,
  readVaultPayload,
  unavailableMemory,
  visibleVaultDirectory,
} from "./store";

import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";
import { MaisterError } from "@/lib/errors";

const namespace = "maister.agent-memory.view.v1";
const cursorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    scope: z.string().length(64),
    kind: z.literal("note"),
    revision: z.string().min(1).max(192),
    offset: z.number().int().min(1).max(MAX_NOTE_CHARS),
  }),
  z.strictObject({
    scope: z.string().length(64),
    kind: z.literal("directory"),
    generation: z.string().max(19),
    after: z.string().min(1).max(512),
  }),
]);

type Cursor = z.infer<typeof cursorSchema>;
type DirectoryEntry = Readonly<{
  path: string;
  kind: "note" | "directory";
  noteId: string | null;
  revisionId: string | null;
  hash: string | null;
}>;

type NotePage = Readonly<{
  kind: "note";
  noteId: string;
  revisionId: string;
  path: string;
  hash: string;
  content: string;
  nextCursor: string | null;
}>;

type DirectoryPage = Readonly<{
  kind: "directory";
  path: string;
  generation: string;
  entries: readonly DirectoryEntry[];
  nextCursor: string | null;
}>;

function parseCursor(raw: string | undefined, scope: string): Cursor | null {
  if (raw === undefined) return null;
  const parsed = cursorSchema.safeParse(parseCursorPayload(namespace, raw));

  if (!parsed.success || parsed.data.scope !== scope)
    throw new MaisterError(
      "CONFIG",
      "Memory cursor does not match this selection",
    );

  return parsed.data;
}

function pageEnd(content: string, offset: number): number {
  const end = Math.min(content.length, offset + MAX_PAGE_CHARS);
  const nextUnit = content.charCodeAt(end);

  return nextUnit >= 0xdc00 && nextUnit <= 0xdfff ? end - 1 : end;
}

async function pageNote(
  db: Db,
  access: VaultAccess,
  revision: VaultRevision,
  cursor: Cursor | null,
  scope: string,
  range: AgentMemoryView["view_range"],
): Promise<NotePage> {
  if (!(await access.canRead(db, revision))) throw unavailableMemory();
  if (
    cursor !== null &&
    (cursor.kind !== "note" || cursor.revision !== revision.id)
  )
    throw new MaisterError("CONFLICT", "Memory note changed while paging");
  if (revision.contentSha256 === null) throw unavailableMemory();
  const body = await readVaultPayload(db, revision);
  const lines = range === undefined ? null : body.split("\n");

  if (range !== undefined && lines && range[0] > lines.length)
    throw new MaisterError("CONFIG", "Memory line range begins after the note");
  const content =
    range && lines
      ? lines
          .slice(range[0] - 1, range[1] === -1 ? undefined : range[1])
          .join("\n")
      : body;
  const offset = cursor?.offset ?? 0;
  const end = pageEnd(content, offset);

  await access.capture(db, [revision]);

  return {
    kind: "note",
    noteId: revision.noteId,
    revisionId: revision.id,
    path: revision.path,
    hash: revision.contentSha256,
    content: content.slice(offset, end),
    nextCursor:
      end === content.length
        ? null
        : signCursorPayload(namespace, {
            scope,
            kind: "note",
            revision: revision.id,
            offset: end,
          }),
  };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function pageDirectory(
  db: Db,
  access: VaultAccess,
  command: AgentMemoryView,
  generation: string,
  revisions: readonly VaultRevision[],
  cursor: Cursor | null,
  scope: string,
): Promise<DirectoryPage> {
  if (
    cursor !== null &&
    (cursor.kind !== "directory" || cursor.generation !== generation)
  )
    throw new MaisterError("CONFLICT", "Memory listing changed while paging");
  const children = new Map<
    string,
    { entry: DirectoryEntry; sources: VaultRevision[] }
  >();

  for (const revision of revisions) {
    const child = revision.path.slice(command.path.length + 1);
    const separator = child.indexOf("/");
    const path =
      separator < 0
        ? revision.path
        : `${command.path}/${child.slice(0, separator)}`;
    const existing = children.get(path);

    if (existing) {
      existing.sources.push(revision);
    } else {
      children.set(path, {
        entry: {
          path,
          kind: separator < 0 ? "note" : "directory",
          noteId: separator < 0 ? revision.noteId : null,
          revisionId: separator < 0 ? revision.id : null,
          hash: separator < 0 ? revision.contentSha256 : null,
        },
        sources: [revision],
      });
    }
  }
  if (command.path !== MEMORY_ROOT && children.size === 0)
    throw unavailableMemory();
  const ordered = [...children.values()]
    .filter(
      ({ entry }) =>
        cursor === null || compareUtf8(entry.path, cursor.after) > 0,
    )
    .sort((a, b) => compareUtf8(a.entry.path, b.entry.path));
  const page = ordered.slice(0, command.limit);
  const last = page[page.length - 1];

  await access.capture(
    db,
    page.flatMap(({ sources }) => sources),
  );

  return {
    kind: "directory",
    generation,
    path: command.path,
    entries: page.map(({ entry }) => entry),
    nextCursor:
      ordered.length > page.length && last
        ? signCursorPayload(namespace, {
            scope,
            kind: "directory",
            generation,
            after: last.entry.path,
          })
        : null,
  };
}

export async function viewAgentMemory(
  db: Db,
  command: AgentMemoryView,
  prepare: PrepareVaultAccess,
): Promise<NotePage | DirectoryPage> {
  return db.transaction(async (tx) => {
    const access = await prepare(tx);
    const vault = await lockVault(tx, access.vaultId);
    const scope = createHash("sha256")
      .update(
        JSON.stringify([
          vault.id,
          access.principalKey,
          command.path,
          command.limit,
          command.view_range,
        ]),
      )
      .digest("hex");
    const cursor = parseCursor(command.cursor, scope);
    const active = await loadActiveHeads(tx, vault.id);
    const note = active.find(({ note }) => note.path === command.path);

    if (note)
      return pageNote(
        tx,
        access,
        note.revision,
        cursor,
        scope,
        command.view_range,
      );
    if (command.view_range !== undefined) throw unavailableMemory();
    const { visible, generation } = await visibleVaultDirectory(
      tx,
      access,
      vault,
      command.path,
      active.map(({ revision }) => revision),
    );

    return pageDirectory(
      tx,
      access,
      command,
      generation,
      visible,
      cursor,
      scope,
    );
  });
}
