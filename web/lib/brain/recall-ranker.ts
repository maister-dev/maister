import "server-only";

import type { BrainItemKind } from "./schema";

import { type SQL } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";

// Project Brain (ADR-122, D9) — the RecallRanker seam. Keeps the one thing "buy"
// does better (recall ranking) swappable behind an interface without moving the
// system-of-record off Postgres. The default pgvector hybrid implementation
// (`rank`) lands in T4.1 (recall.ts wires it + writes the snapshot); this file
// owns the contract + injection so the rest of the code depends on the seam.

export const RANKER_VERSION = "hybrid-v1";

export type RecallRankerDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface RecallQuery {
  projectId: string;
  queryText: string;
  // The query embedding is computed once by the caller (recall.ts) and injected,
  // so the ranker performs NO LLM/embedding call itself (E-6).
  queryEmbedding: number[];
  model: string;
  dimensions: number;
  limit: number;
  kinds?: BrainItemKind[];
  minConfidence?: number;
}

export interface RankedBrainItem {
  id: string;
  kind: BrainItemKind;
  title: string;
  content: string;
  confidence: number;
  score: number;
  createdAt: Date;
  expiresAt: Date | null;
  provenance: { runId: string | null; gateKind: string | null };
}

export interface RecallRanker {
  readonly version: string;
  rank(db: RecallRankerDb, q: RecallQuery): Promise<RankedBrainItem[]>;
}

// The default pgvector hybrid ranker. `rank` is implemented in T4.1 (Phase 4);
// no caller invokes it before recall.ts is wired.
export const pgVectorRecallRanker: RecallRanker = {
  version: RANKER_VERSION,

  async rank(): Promise<RankedBrainItem[]> {
    throw new MaisterError(
      "PRECONDITION",
      "pgVectorRecallRanker.rank is implemented in T4.1 (hybrid recall)",
    );
  },
};

// Injection point (SOLID/DIP): callers pass an override for tests or an
// alternate reranker; otherwise the default pgvector ranker is used.
export function resolveRecallRanker(override?: RecallRanker): RecallRanker {
  return override ?? pgVectorRecallRanker;
}
