import "server-only";

import type { BrainItemKind } from "./schema";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { sha256 } from "./codec";
import { assertBrainProvisioned, assertProjectBrainEnabled } from "./guard";
import {
  getBrainEmbeddingClient,
  type OpenAiCompatibleClient,
} from "./openai-compatible";
import { BRAIN_POLICY } from "./policy";
import {
  resolveRecallRanker,
  type RankedBrainItem,
  type RecallRanker,
} from "./recall-ranker";

import { getDb } from "@/lib/db/client";

// Project Brain (ADR-122) recall orchestration: embed the query ONCE, then hand
// the ready embedding to the RecallRanker (NO LLM at read — E-6). The snapshot
// write is the caller's job (explicit recall / ambient inject), via
// writeBrainSnapshot; recall() itself is a pure read.

type RecallDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface RecallOptions {
  limit?: number;
  kinds?: BrainItemKind[];
  minConfidence?: number;
  db?: RecallDb;
  client?: OpenAiCompatibleClient;
  ranker?: RecallRanker;
  // Precomputed query embedding — lets the ambient path memoize per runner and
  // avoid re-embedding on every node attempt (T4.3).
  queryEmbedding?: number[];
}

export async function recall(
  projectId: string,
  queryText: string,
  opts: RecallOptions = {},
): Promise<RankedBrainItem[]> {
  assertBrainProvisioned();

  const db = opts.db ?? (getDb() as unknown as RecallDb);

  // Enablement belt INSIDE the service (F1 recurrence-proof): every future
  // caller inherits the kill switch, and it runs before the paid embed call.
  await assertProjectBrainEnabled(db, projectId);

  const client =
    opts.client ??
    (await getBrainEmbeddingClient(
      db as unknown as Parameters<typeof getBrainEmbeddingClient>[0],
    ));
  const ranker = resolveRecallRanker(opts.ranker);
  const limit = opts.limit ?? BRAIN_POLICY.ambientK;
  const queryEmbedding =
    opts.queryEmbedding ?? (await client.embed([queryText]))[0];

  return ranker.rank(db, {
    projectId,
    queryText,
    queryEmbedding,
    model: client.model,
    dimensions: client.dimensions,
    limit,
    kinds: opts.kinds,
    minConfidence: opts.minConfidence,
  });
}

export function queryHash(query: string): string {
  return sha256(query);
}

export interface SnapshotInput {
  projectId: string;
  runId?: string | null;
  nodeAttemptId?: string | null;
  actorType: "user" | "agent" | "system";
  actorId: string;
  trigger: "ambient" | "explicit";
  query: string;
  embeddingModel: string;
  returnedItems: Array<{ itemId: string; score: number }>;
  rankerVersion: string;
}

// Every run/node that consumes Brain context records a snapshot (E-12).
export async function writeBrainSnapshot(
  db: RecallDb,
  s: SnapshotInput,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO brain_snapshots
      (id, project_id, run_id, node_attempt_id, actor_type, actor_id, trigger,
       query, query_hash, embedding_model, returned_items, ranker_version)
    VALUES
      (${randomUUID()}, ${s.projectId}, ${s.runId ?? null}, ${s.nodeAttemptId ?? null},
       ${s.actorType}, ${s.actorId}, ${s.trigger}, ${s.query}, ${queryHash(s.query)},
       ${s.embeddingModel}, ${JSON.stringify(s.returnedItems)}::jsonb, ${s.rankerVersion})
  `);
}
