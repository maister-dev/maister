import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { PrepareVaultAccess, VaultAccess, VaultRevision } from "./store";
import type { MemoryLink } from "./structure";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { lookupNotePath } from "./indexes";
import { makeMemoryEntityResolver } from "./entity-links";
import { loadActiveHeads, lockVault, unavailableMemory } from "./store";
import { memoryLookupKey } from "./structure";

import { MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";

type PageSelection = Readonly<{ cursor?: string; limit: number }>;
type NoteRef = Readonly<{ noteId: string; revisionId: string; path: string }>;
type OutgoingLink = Readonly<{
  raw: string;
  notePath: string | null;
  href: string | null;
}>;
type NoteStructure = Readonly<{
  aliases: readonly string[];
  state: "ready" | "repair";
  links: readonly OutgoingLink[];
}>;
type IndexRow = {
  note_id: string;
  revision_id: string;
  path: string;
  basename_key: string;
  tags: string[];
  alias_keys: string[];
  aliases: string[];
  headings: string[];
  state: "ready" | "repair";
};

const indexCursor = z.strictObject({
  scope: z.string().length(64),
  generation: z.string().length(64),
  offset: z.number().int().min(1).max(16384),
});
const cursorNamespace = "maister.agent-memory.index.v1";

export async function visibleMemoryHeads(
  tx: Db,
  access: VaultAccess,
): Promise<VaultRevision[]> {
  const visible: VaultRevision[] = [];

  for (const { revision } of await loadActiveHeads(tx, access.vaultId)) {
    if (await access.canRead(tx, revision)) visible.push(revision);
  }

  return visible;
}

export function pageIndexItems<T>(
  items: readonly T[],
  request: PageSelection,
  scope: string,
  generation: string,
): Readonly<{ items: readonly T[]; nextCursor: string | null }> {
  const parsed = request.cursor
    ? indexCursor.safeParse(parseCursorPayload(cursorNamespace, request.cursor))
    : null;
  if (parsed && (!parsed.success || parsed.data.scope !== scope))
    throw new MaisterError(
      "CONFIG",
      "Memory cursor does not match this selection",
    );
  const cursor = parsed?.success ? parsed.data : null;
  if (cursor && cursor.generation !== generation)
    throw new MaisterError("CONFLICT", "Memory index changed while paging");
  const offset = cursor?.offset ?? 0;
  const next = offset + request.limit;

  return {
    items: items.slice(offset, next),
    nextCursor:
      next < items.length
        ? signCursorPayload(cursorNamespace, {
            scope,
            generation,
            offset: next,
          })
        : null,
  };
}

export function memoryIndexScope(
  principalKey: string,
  vaultId: string,
  ...selection: unknown[]
): string {
  return memoryIndexGeneration([principalKey, vaultId, ...selection]);
}

export function memoryIndexGeneration(items: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

async function matchingIndexes(
  tx: Db,
  vaultId: string,
  visible: readonly VaultRevision[],
): Promise<IndexRow[]> {
  if (visible.length === 0) return [];
  const result = await tx.execute<IndexRow>(sql`
    SELECT note_id,revision_id,path,basename_key,tags,alias_keys,aliases,headings,state
    FROM agent_memory_note_index
    WHERE vault_id=${vaultId}
      AND revision_id IN (${sql.join(
        visible.map(({ id }) => sql`${id}`),
        sql`,`,
      )})
    ORDER BY path COLLATE "C"
  `);

  return result.rows;
}

function exactVisibleMatch(
  indexes: readonly IndexRow[],
  target: string,
): IndexRow | undefined {
  const exact = indexes.find((entry) => entry.path === lookupNotePath(target));
  if (exact) return exact;
  const key = memoryLookupKey(target.replace(/\.md$/, ""));
  const possible = indexes.filter(
    (entry) => entry.basename_key === key || entry.alias_keys.includes(key),
  );

  return possible.length === 1 ? possible[0] : undefined;
}

function ref(index: IndexRow): NoteRef {
  return {
    noteId: index.note_id,
    revisionId: index.revision_id,
    path: index.path,
  };
}

export async function listMemoryTags(
  db: Db,
  request: PageSelection,
  prepare: PrepareVaultAccess,
) {
  return db.transaction(async (tx) => {
    const access = await prepare(tx);
    const vault = await lockVault(tx, access.vaultId);
    const visible = await visibleMemoryHeads(tx, access);
    const indexes = await matchingIndexes(tx, vault.id, visible);
    const tags = new Map<string, Set<string>>();

    for (const entry of indexes) {
      for (const tag of entry.tags) {
        const contributors = tags.get(tag) ?? new Set<string>();

        contributors.add(entry.revision_id);
        tags.set(tag, contributors);
      }
    }
    const page = pageIndexItems(
      [...tags.keys()].sort(),
      request,
      memoryIndexScope(access.principalKey, vault.id, "tags", request.limit),
      memoryIndexGeneration(indexes.map(({ revision_id }) => revision_id)),
    );
    const used = new Set(page.items.flatMap((tag) => [...tags.get(tag)!]));

    await access.capture(
      tx,
      visible.filter((head) => used.has(head.id)),
    );

    return {
      items: page.items.map((tag) => ({ tag, count: tags.get(tag)!.size })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function listMemoryBacklinks(
  db: Db,
  request: PageSelection & Readonly<{ path: string; includeStructure?: true }>,
  prepare: PrepareVaultAccess,
) {
  return db.transaction(async (tx) => {
    const access = await prepare(tx);
    const vault = await lockVault(tx, access.vaultId);
    const visible = await visibleMemoryHeads(tx, access);
    const target = visible.find((head) => head.path === request.path);

    if (!target) throw unavailableMemory();
    const indexes = await matchingIndexes(tx, vault.id, visible);
    const links =
      indexes.length > 0
        ? (
            await tx.execute<{
              source_revision_id: string;
              target: string;
              fragment: string | null;
            }>(sql`
      SELECT source_revision_id,target,fragment FROM agent_memory_note_links
      WHERE vault_id=${vault.id} AND kind='note'
        AND source_revision_id IN (${sql.join(
          indexes.map(({ revision_id }) => sql`${revision_id}`),
          sql`,`,
        )})
    `)
          ).rows
        : [];
    const incoming = new Set<string>();

    for (const row of links) {
      const match = exactVisibleMatch(indexes, row.target);

      if (
        match?.revision_id === target.id &&
        (row.fragment === null || match.headings.includes(row.fragment))
      )
        incoming.add(row.source_revision_id);
    }
    const page = pageIndexItems(
      indexes.filter((entry) => incoming.has(entry.revision_id)),
      request,
      memoryIndexScope(
        access.principalKey,
        vault.id,
        "backlinks",
        target.id,
        request.limit,
      ),
      memoryIndexGeneration(
        indexes
          .filter((entry) => incoming.has(entry.revision_id))
          .map(({ revision_id }) => revision_id),
      ),
    );
    const used = new Set([
      target.id,
      ...page.items.map((entry) => entry.revision_id),
    ]);

    let structure: NoteStructure | undefined;
    const ownIndex = indexes.find(
      ({ revision_id }) => revision_id === target.id,
    );
    if (request.includeStructure && ownIndex) {
      const ownLinks = await tx.execute<MemoryLink>(sql`
        SELECT raw,kind,target,fragment FROM agent_memory_note_links
        WHERE (vault_id, source_revision_id)=(${vault.id},${target.id})
        ORDER BY raw COLLATE "C" LIMIT 100
      `);
      const entity = await makeMemoryEntityResolver(tx, access, vault);
      const outgoing: OutgoingLink[] = [];

      for (const link of ownLinks.rows) {
        if (link.kind !== "note") {
          outgoing.push({
            raw: link.raw,
            notePath: null,
            href: await entity(link),
          });
          continue;
        }
        const match = exactVisibleMatch(indexes, link.target);
        const headingMatches =
          match &&
          (link.fragment === null || match.headings.includes(link.fragment));

        if (headingMatches) used.add(match.revision_id);
        outgoing.push({
          raw: link.raw,
          notePath: headingMatches ? match.path : null,
          href: null,
        });
      }
      structure = {
        aliases: ownIndex.aliases,
        state: ownIndex.state,
        links: outgoing,
      };
    }

    await access.capture(
      tx,
      visible.filter((head) => used.has(head.id)),
    );

    return {
      items: page.items.map(ref),
      nextCursor: page.nextCursor,
      ...(structure && { structure }),
    };
  });
}
