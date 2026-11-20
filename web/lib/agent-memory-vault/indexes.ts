import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { VaultRevision } from "./store";
import type { MemoryStructure } from "./structure";

import { sql } from "drizzle-orm";
import pino from "pino";

import { memoryLookupKey, parseMemoryStructure } from "./structure";

import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-memory-index",
  level: process.env.LOG_LEVEL ?? "info",
});

const noMetadata: MemoryStructure = {
  aliases: [],
  tags: [],
  headings: [],
  links: [],
  body: "",
};

export function lookupNotePath(target: string): string {
  const path = target.startsWith("/memories/") ? target : `/memories/${target}`;

  return path.endsWith(".md") ? path : path + ".md";
}

function noteBasename(path: string): string {
  return memoryLookupKey(path.split("/").at(-1)?.replace(/\.md$/, "") ?? "");
}

export async function indexMemoryRevision(
  tx: Db,
  revision: VaultRevision,
  content: string | null,
  policy: "validate" | "retain-legacy",
): Promise<void> {
  await tx.execute(sql`DELETE FROM agent_memory_note_index
    WHERE vault_id=${revision.vaultId} AND note_id=${revision.noteId}`);
  if (content === null) return;
  let structure: MemoryStructure;
  let state: "ready" | "repair" = "ready";

  try {
    structure = parseMemoryStructure(content);
  } catch (error) {
    if (
      policy !== "retain-legacy" ||
      !isMaisterError(error) ||
      error.code !== "CONFIG"
    )
      throw error;
    structure = { ...noMetadata, body: content };
    state = "repair";
  }
  const aliases = structure.aliases.map(memoryLookupKey);
  const indexText = [
    revision.path,
    ...structure.tags,
    ...structure.aliases,
    structure.body,
  ].join("\n");

  await tx.execute(sql`
    INSERT INTO agent_memory_note_index
      (vault_id,note_id,revision_id,path,basename_key,tags,aliases,alias_keys,headings,state,document)
    VALUES (${revision.vaultId},${revision.noteId},${revision.id},${revision.path},${noteBasename(revision.path)},
      ${JSON.stringify(structure.tags)}::jsonb,${JSON.stringify(structure.aliases)}::jsonb,
      ${JSON.stringify(aliases)}::jsonb,${JSON.stringify(structure.headings)}::jsonb,${state},
      to_tsvector('english',${indexText}) || to_tsvector('russian',${indexText}))
  `);
  if (structure.links.length) {
    const links = structure.links.map((link) => ({
      ...link,
      lookup_path: link.kind === "note" ? lookupNotePath(link.target) : null,
      lookup_key:
        link.kind === "note"
          ? memoryLookupKey(link.target.replace(/\.md$/, ""))
          : null,
    }));

    await tx.execute(sql`
      INSERT INTO agent_memory_note_links
        (vault_id,source_note_id,source_revision_id,raw,kind,target,fragment,lookup_path,lookup_key,state)
      SELECT ${revision.vaultId},${revision.noteId},${revision.id},
        edge.raw,edge.kind,edge.target,edge.fragment,edge.lookup_path,edge.lookup_key,
        CASE edge.kind WHEN 'note' THEN 'unresolved' WHEN 'unresolved' THEN 'unresolved' ELSE 'pointer' END
      FROM jsonb_to_recordset(${JSON.stringify(links)}::jsonb)
        AS edge(raw text,kind text,target text,fragment text,lookup_path text,lookup_key text)
    `);
  }
  log.debug(
    {
      vaultId: revision.vaultId,
      revisionId: revision.id,
      tags: structure.tags.length,
      aliases: structure.aliases.length,
      links: structure.links.length,
      state,
    },
    "memory note indexed",
  );
}

/** Exact paths win. Fallback requires one distinct basename or alias match. */
export async function resolveIndexedMemoryLinks(
  tx: Db,
  vaultId: string,
): Promise<void> {
  await tx.execute(sql`
    WITH targets AS (
      SELECT edge.vault_id,edge.source_note_id,edge.raw,
        CASE WHEN exact.note_id IS NOT NULL THEN exact.note_id
             WHEN fallback.matches=1 THEN fallback.note_id
             ELSE NULL END AS resolved
      FROM agent_memory_note_links edge
      LEFT JOIN agent_memory_note_index exact
        ON exact.vault_id=edge.vault_id AND exact.path=edge.lookup_path
      LEFT JOIN LATERAL (
        SELECT count(*) AS matches,min(target.note_id) AS note_id
        FROM agent_memory_note_index target
        WHERE target.vault_id=edge.vault_id AND
          (target.basename_key=edge.lookup_key OR target.alias_keys ? edge.lookup_key)
      ) fallback ON exact.note_id IS NULL
      WHERE edge.vault_id=${vaultId} AND edge.kind='note'
    ), visible_heading AS (
      SELECT target.vault_id,target.source_note_id,target.raw,
        CASE WHEN edge.fragment IS NULL OR head.headings ? edge.fragment
             THEN target.resolved ELSE NULL END AS resolved
      FROM targets target
      JOIN agent_memory_note_links edge USING (vault_id,source_note_id,raw)
      LEFT JOIN agent_memory_note_index head ON head.vault_id=target.vault_id AND head.note_id=target.resolved
    )
    UPDATE agent_memory_note_links edge
    SET target_note_id=target.resolved, state=CASE WHEN target.resolved IS NULL THEN 'unresolved' ELSE 'resolved' END
    FROM visible_heading target
    WHERE (edge.vault_id,edge.source_note_id,edge.raw)=(target.vault_id,target.source_note_id,target.raw)
      AND (edge.target_note_id IS DISTINCT FROM target.resolved OR
        edge.state IS DISTINCT FROM CASE WHEN target.resolved IS NULL THEN 'unresolved' ELSE 'resolved' END)
  `);
}
