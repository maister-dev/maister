import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { PrepareVaultAccess } from "./store";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  currentMemoryEmbeddingProfile,
  memoryVectorLiteral,
} from "./embedding-profile";
import {
  memoryIndexGeneration,
  memoryIndexScope,
  pageIndexItems,
  visibleMemoryHeads,
} from "./index-queries";
import { lockVault } from "./store";

import { hybridRelevance } from "@/lib/brain/recall-ranker";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-memory-search",
  level: process.env.LOG_LEVEL ?? "info",
});

export type MemorySearch = Readonly<{
  q: string;
  tag?: string;
  mode: "lexical" | "vector";
  limit: number;
  cursor?: string;
}>;

type SearchRow = {
  note_id: string;
  revision_id: string;
  path: string;
  score: number;
  snippet: string;
};

export async function searchMemory(
  db: Db,
  request: MemorySearch,
  prepare: PrepareVaultAccess,
) {
  const started = performance.now();
  const requestedProfile =
    request.mode === "vector"
      ? await db.transaction(async (tx) => {
          await prepare(tx);

          return currentMemoryEmbeddingProfile(tx);
        })
      : null;
  const embedding = requestedProfile
    ? (await requestedProfile.client.embed([request.q]))[0]
    : undefined;

  if (requestedProfile && !embedding)
    throw new MaisterError(
      "EMBEDDING_UNAVAILABLE",
      "Provider returned no query vector",
    );
  const filtered = await db.transaction(async (tx) => {
    const access = await prepare(tx);
    const vault = await lockVault(tx, access.vaultId);
    const visible = await visibleMemoryHeads(tx, access);

    if (visible.length === 0) return { hits: [], nextCursor: null };
    const profile = requestedProfile
      ? await currentMemoryEmbeddingProfile(tx)
      : null;

    if (profile?.generation !== requestedProfile?.generation)
      throw new MaisterError(
        "CONFLICT",
        "Memory embedding configuration changed while searching",
      );
    const query = sql`websearch_to_tsquery('english',${request.q}) || websearch_to_tsquery('russian',${request.q})`;
    const lexical =
      request.q === "" ? sql`0.0` : sql`ts_rank(projection.document, ${query})`;
    const vector =
      profile && embedding
        ? sql`COALESCE(1.0 - (cache.vector <=> ${memoryVectorLiteral(embedding)}::vector),0)`
        : null;
    const search = await tx.execute<SearchRow>(sql`
      SELECT projection.note_id,projection.revision_id,projection.path,
        ${vector ? hybridRelevance(vector, lexical) : lexical}::float8 AS score,
        left(payload.content,240) AS snippet
      FROM agent_memory_note_index projection
      JOIN agent_memory_revision_payloads payload USING (vault_id,note_id,revision_id)
      ${
        profile
          ? sql`LEFT JOIN agent_memory_embeddings cache
        ON (cache.vault_id,cache.note_id,cache.revision_id)=(projection.vault_id,projection.note_id,projection.revision_id)
        AND cache.model=${profile.model} AND cache.dimensions=${profile.dimensions}
        AND cache.generation=${profile.generation} AND cache.state='ready'`
          : sql``
      }
      WHERE projection.vault_id=${vault.id}
        AND projection.revision_id IN (${sql.join(
          visible.map(({ id }) => sql`${id}`),
          sql`,`,
        )})
        ${request.tag === undefined ? sql`` : sql`AND projection.tags ? ${request.tag}`}
        ${request.q === "" ? sql`` : sql`AND (projection.document @@ (${query}) ${profile ? sql`OR cache.vector IS NOT NULL` : sql``})`}
      ORDER BY score DESC, projection.path COLLATE "C", projection.revision_id
    `);
    const scope = memoryIndexScope(
      access.principalKey,
      vault.id,
      "search",
      request.q,
      request.tag,
      request.mode,
      request.limit,
    );
    const generation = memoryIndexGeneration([
      profile?.generation,
      ...search.rows.map(({ revision_id, score }) => [revision_id, score]),
    ]);
    const page = pageIndexItems(search.rows, request, scope, generation);
    const delivered = new Set(page.items.map(({ revision_id }) => revision_id));

    await access.capture(
      tx,
      visible.filter(({ id }) => delivered.has(id)),
    );

    return {
      hits: page.items.map((row) => ({
        noteId: row.note_id,
        revisionId: row.revision_id,
        path: row.path,
        score: row.score,
        snippet: row.snippet.toWellFormed().slice(0, 512).toWellFormed(),
      })),
      nextCursor: page.nextCursor,
    };
  });

  log.debug(
    {
      mode: request.mode,
      queryChars: request.q.length,
      hits: filtered.hits.length,
      elapsedMs: performance.now() - started,
    },
    "memory search completed",
  );

  return filtered;
}
