import "server-only";

import type { BrainItemKind, BrainSourceRef } from "./schema";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { splitForEmbedding } from "./chunk";
import { sha256, toVectorLiteral } from "./codec";
import { createRetainSourceEdges } from "./edges";
import { assertBrainSchemaApplied, assertProjectBrainEnabled } from "./guard";
import { assertRetainHomeAllowsOwned } from "./home-resolution";
import {
  getBrainEmbeddingClient,
  type OpenAiCompatibleClient,
} from "./openai-compatible";
import { BRAIN_POLICY } from "./policy";

import { MaisterError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-error";

const log = pino({
  name: "brain:retain",
  level: process.env.LOG_LEVEL ?? "info",
});

// Project Brain retain: embed outside the transaction, then serialize owner
// writes. Exact content is idempotent; distinct near claims remain distinct.
// Similarity creates a review candidate, never a merge or truth decision.
// content_hash exact-dup is an idempotent no-op; the partial UNIQUE is the
// race belt (E-2/E-3). Embeddings are append-only per generation — a re-embed
// NEVER mutates an existing row.

export interface RetainInput {
  kind: BrainItemKind;
  content: string;
  title?: string;
  tags?: string[];
  sourceRef?: BrainSourceRef;
}

export interface RetainProvenance {
  sourceRunId?: string | null;
  sourceNodeAttemptId?: string | null;
  sourceDomainEventId?: number | null;
  sourceGateKind?: string | null;
}

export interface RetainResult {
  // null ONLY on the redelivered-ledger-hit path when the first delivery
  // reinforced/deduped (no source_domain_event_id row to look up).
  itemId: string | null;
  reinforced: boolean;
}

type TxLike = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};
type RetainDb = TxLike & {
  transaction<T>(fn: (tx: TxLike) => Promise<T>): Promise<T>;
};

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
  const db = opts.db ?? (getDb() as unknown as RetainDb);

  await assertBrainSchemaApplied(db);

  // Enablement belt INSIDE the service (F1 recurrence-proof): every future
  // caller inherits the kill switch, and it runs before the paid embed call.
  await assertProjectBrainEnabled(db, projectId);

  const content = input.content.trim();

  if (!content) throw new MaisterError("CONFIG", "retain content is empty");

  const kind = input.kind;

  await assertRetainHomeAllowsOwned(db, projectId, kind);

  const client =
    opts.client ??
    (await getBrainEmbeddingClient(
      db as unknown as Parameters<typeof getBrainEmbeddingClient>[0],
    ));

  const contentHash = sha256(content);
  const title = (input.title?.trim() || deriveTitle(content)).slice(0, 512);
  const tags = input.tags ?? [];

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

      // Claim delivered events in the same transaction as their knowledge effect.
      // Redelivery cannot create additional claims, source evidence or confidence.
      if (provenance.sourceDomainEventId != null) {
        const claimed = await tx.execute(sql`
          INSERT INTO brain_harvested_events (project_id, domain_event_id)
          VALUES (${projectId}, ${provenance.sourceDomainEventId})
          ON CONFLICT DO NOTHING
          RETURNING domain_event_id
        `);

        if (claimed.rows.length === 0) {
          const prior = await tx.execute(sql`
            SELECT id FROM brain_items
            WHERE project_id = ${projectId}
              AND source_domain_event_id = ${provenance.sourceDomainEventId} AND visibility = 'owner_grants' AND (source_restrictions IS NULL OR source_restrictions='[]'::jsonb)
            LIMIT 1
          `);

          return {
            itemId: prior.rows[0] ? String(prior.rows[0].id) : null,
            reinforced: false,
          };
        }
      }

      // Exact content_hash dup on an active row → idempotent no-op.
      const dup = await tx.execute(sql`
        SELECT id FROM brain_items
        WHERE project_id = ${projectId} AND content_hash = ${contentHash}
          AND status = 'active' AND visibility = 'owner_grants' AND (source_restrictions IS NULL OR source_restrictions='[]'::jsonb)
        LIMIT 1
      `);

      if (dup.rows[0]) {
        return { itemId: String(dup.rows[0].id), reinforced: false };
      }

      let potentialConflict: { id: string; revision: number } | null = null;

      // Near claims of the same kind are review candidates. Their assertions,
      // applicability and evidence identities remain separate.
      const near = await tx.execute(sql`
        SELECT e.item_id AS item_id, i.current_revision AS revision,
               MIN((e.vector::vector(${dimRaw})) <=> ${queryVec}::vector(${dimRaw})) AS dist
        FROM brain_embeddings e
        JOIN brain_items i ON i.id = e.item_id
        WHERE i.project_id = ${projectId} AND i.status = 'active' AND i.visibility = 'owner_grants' AND (i.source_restrictions IS NULL OR i.source_restrictions='[]'::jsonb)
          AND i.kind = ${kind}
          AND e.embedding_model = ${client.model}
          AND e.embedding_dimensions = ${n}
        GROUP BY e.item_id, i.current_revision
        ORDER BY dist ASC
        LIMIT 1
      `);
      const best = near.rows[0] as
        { item_id: string; revision: number; dist: number } | undefined;

      if (best && 1 - Number(best.dist) > BRAIN_POLICY.dedupCosineThreshold) {
        potentialConflict = {
          id: String(best.item_id),
          revision: Number(best.revision),
        };
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
           source_gate_kind, source_ref, expires_at)
        VALUES
          (${itemId}, ${projectId}, ${kind}, ${title}, ${content}, 'active',
           ${BRAIN_POLICY.initialConfidence}, ${contentHash},
           ${JSON.stringify(tags)}::jsonb,
           ${provenance.sourceRunId ?? null}, ${provenance.sourceNodeAttemptId ?? null},
           ${provenance.sourceDomainEventId ?? null}, ${provenance.sourceGateKind ?? null},
           ${JSON.stringify(input.sourceRef ?? null)}::jsonb,
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
          ON CONFLICT (item_id, split_ordinal, embedding_model, embedding_dimensions)
          DO NOTHING
        `);
      }

      if (potentialConflict) {
        await tx.execute(sql`
          INSERT INTO brain_edges(id,project_id,from_ref,to_ref,relation,confidence,claim_state,from_revision,to_revision,claim_actor)
          SELECT ${randomUUID()},${projectId},${JSON.stringify({ type: "item", id: itemId })}::jsonb,
            ${JSON.stringify({ type: "item", id: potentialConflict.id })}::jsonb,'references',0,'potential_conflict',1,${potentialConflict.revision},
            '{"kind":"system","id":"similarity_candidate","runId":null,"attemptId":null}'::jsonb
          FROM brain_items WHERE id=${potentialConflict.id} AND project_id=${projectId} AND visibility='owner_grants' AND (source_restrictions IS NULL OR source_restrictions='[]'::jsonb)
        `);
        log.debug(
          { projectId, itemId, candidateId: potentialConflict.id },
          "near claim retained for review",
        );
      }

      await createRetainSourceEdges(tx, {
        projectId,
        itemId,
        sourceRef: input.sourceRef,
      });

      return { itemId, reinforced: false };
    });
  } catch (err) {
    // Belt: the partial UNIQUE (project_id, content_hash) WHERE active turns a
    // pre-check race (unreachable given the advisory lock) into a constraint
    // violation. Resolve to the idempotent no-op — exactly one active row.
    if (isUniqueViolation(err)) {
      const existing = await db.execute(sql`
        SELECT id FROM brain_items
        WHERE project_id = ${projectId} AND content_hash = ${contentHash}
          AND status = 'active' AND visibility = 'owner_grants' AND (source_restrictions IS NULL OR source_restrictions='[]'::jsonb)
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
