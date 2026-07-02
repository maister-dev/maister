import "server-only";

import type { BrainItemKind } from "./schema";

import { createHash, randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { splitForEmbedding } from "./chunk";
import { assertBrainProvisioned } from "./guard";
import {
  getBrainEmbeddingClient,
  type OpenAiCompatibleClient,
} from "./openai-compatible";
import { BRAIN_POLICY } from "./policy";

import { MaisterError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";

// Project Brain (ADR-122) retain: the self-improving write. embed OUTSIDE the
// transaction, then within ONE transaction take a per-project advisory lock and
// dedup-or-reinforce (cosine > τ → reinforce; else insert at confidence₀ + TTL).
// content_hash exact-dup is an idempotent no-op; the partial UNIQUE is the
// race belt (E-2/E-3). Embeddings are append-only per generation — a re-embed
// NEVER mutates an existing row.

export interface RetainInput {
  kind: BrainItemKind;
  content: string;
  title?: string;
  tags?: string[];
}

export interface RetainProvenance {
  sourceRunId?: string | null;
  sourceNodeAttemptId?: string | null;
  sourceDomainEventId?: number | null;
  sourceGateKind?: string | null;
}

export interface RetainResult {
  itemId: string;
  reinforced: boolean;
}

type TxLike = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};
type RetainDb = TxLike & {
  transaction<T>(fn: (tx: TxLike) => Promise<T>): Promise<T>;
};

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function deriveTitle(content: string): string {
  const firstLine =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? content;

  return firstLine.slice(0, 200);
}

export async function retain(
  projectId: string,
  input: RetainInput,
  provenance: RetainProvenance = {},
  opts: { db?: RetainDb; client?: OpenAiCompatibleClient } = {},
): Promise<RetainResult> {
  assertBrainProvisioned();

  const db = opts.db ?? (getDb() as unknown as RetainDb);
  const client =
    opts.client ??
    (await getBrainEmbeddingClient(
      db as unknown as Parameters<typeof getBrainEmbeddingClient>[0],
    ));

  const content = input.content.trim();

  if (!content) throw new MaisterError("CONFIG", "retain content is empty");

  const contentHash = sha256(content);
  const title = (input.title?.trim() || deriveTitle(content)).slice(0, 512);
  const tags = input.tags ?? [];
  const kind = input.kind;

  // Embed OUTSIDE the transaction (network) — the tx does DB work only.
  const segments = splitForEmbedding(content);
  const vectors = await client.embed(segments);
  const n = client.dimensions;
  const dimRaw = sql.raw(String(n));
  const queryVec = toVectorLiteral(vectors[0]);

  try {
    return await db.transaction(async (tx) => {
      // Serialize concurrent retains per project (harvest is lease-serialized,
      // but an MCP memory_retain can race it). Released at commit/rollback.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`,
      );

      // Exact content_hash dup on an active row → idempotent no-op.
      const dup = await tx.execute(sql`
        SELECT id FROM brain_items
        WHERE project_id = ${projectId} AND content_hash = ${contentHash}
          AND status = 'active'
        LIMIT 1
      `);

      if (dup.rows[0]) {
        return { itemId: String(dup.rows[0].id), reinforced: false };
      }

      // Near-dup over the ACTIVE generation of this project's active items.
      const near = await tx.execute(sql`
        SELECT e.item_id AS item_id,
               MIN((e.vector::vector(${dimRaw})) <=> ${queryVec}::vector(${dimRaw})) AS dist
        FROM brain_embeddings e
        JOIN brain_items i ON i.id = e.item_id
        WHERE i.project_id = ${projectId} AND i.status = 'active'
          AND e.embedding_model = ${client.model}
          AND e.embedding_dimensions = ${n}
        GROUP BY e.item_id
        ORDER BY dist ASC
        LIMIT 1
      `);
      const best = near.rows[0] as
        | { item_id: string; dist: number }
        | undefined;

      if (best && 1 - Number(best.dist) > BRAIN_POLICY.dedupCosineThreshold) {
        await tx.execute(sql`
          UPDATE brain_items
          SET confidence = LEAST(confidence + ${BRAIN_POLICY.reinforceConfidenceStep}, 1),
              reinforcement_count = reinforcement_count + 1,
              last_reinforced_at = now(),
              expires_at = CASE WHEN expires_at IS NULL THEN NULL
                                ELSE now() + ${sql.raw(String(BRAIN_POLICY.reinforceTtlDays))} * INTERVAL '1 day' END,
              updated_at = now()
          WHERE id = ${best.item_id}
        `);

        return { itemId: String(best.item_id), reinforced: true };
      }

      // Insert a new item + one embedding row per segment (this generation).
      const itemId = randomUUID();
      const expiresClause =
        kind === "state_fact"
          ? sql`NULL`
          : sql`now() + ${sql.raw(String(BRAIN_POLICY.ttlDays))} * INTERVAL '1 day'`;

      await tx.execute(sql`
        INSERT INTO brain_items
          (id, project_id, kind, title, content, status, confidence, content_hash,
           tags, source_run_id, source_node_attempt_id, source_domain_event_id,
           source_gate_kind, expires_at)
        VALUES
          (${itemId}, ${projectId}, ${kind}, ${title}, ${content}, 'active',
           ${BRAIN_POLICY.initialConfidence}, ${contentHash},
           ${JSON.stringify(tags)}::jsonb,
           ${provenance.sourceRunId ?? null}, ${provenance.sourceNodeAttemptId ?? null},
           ${provenance.sourceDomainEventId ?? null}, ${provenance.sourceGateKind ?? null},
           ${expiresClause})
      `);

      for (let i = 0; i < segments.length; i++) {
        await tx.execute(sql`
          INSERT INTO brain_embeddings
            (id, item_id, split_ordinal, vector, embedding_provider, embedding_model,
             embedding_dimensions, embedding_version, source_hash, content_hash)
          VALUES
            (${randomUUID()}, ${itemId}, ${i}, ${toVectorLiteral(vectors[i])}::vector,
             ${client.provider}, ${client.model}, ${n}, ${client.version},
             ${sha256(segments[i])}, ${contentHash})
        `);
      }

      return { itemId, reinforced: false };
    });
  } catch (err) {
    // Belt: the partial UNIQUE (project_id, content_hash) WHERE active turns a
    // pre-check race (unreachable given the advisory lock) into a constraint
    // violation. Resolve to the idempotent no-op — exactly one active row.
    if ((err as { code?: string }).code === "23505") {
      const existing = await db.execute(sql`
        SELECT id FROM brain_items
        WHERE project_id = ${projectId} AND content_hash = ${contentHash}
          AND status = 'active'
        LIMIT 1
      `);

      if (existing.rows[0]) {
        return { itemId: String(existing.rows[0].id), reinforced: false };
      }

      throw new MaisterError("CONFLICT", "concurrent retain content conflict");
    }

    throw err;
  }
}
