import "server-only";

import type { BrainAmbientEntry } from "@/lib/flows/graph/run-context";

import { createHash } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { isBrainProvisioned, isProjectBrainEnabled } from "./guard";
import {
  getBrainEmbeddingClient,
  type OpenAiCompatibleClient,
} from "./openai-compatible";
import { BRAIN_POLICY } from "./policy";
import { queryHash, recall, writeBrainSnapshot } from "./recall";
import { RANKER_VERSION } from "./recall-ranker";

// Project Brain (ADR-122) ambient P7 injection (flow runs only). Best-effort:
// NEVER throws — every failure (enablement query, provider, recall, snapshot)
// degrades to an undefined projection; it never fails the run. Enablement is
// runs.brain_context (opt-in; null = off in A) AND the live projects.
// brain_enabled kill switch, re-checked here on every call. Injection is
// floored at BRAIN_POLICY.ambientMinConfidence — an item must have been
// reinforced at least once before it is auto-injected (explicit recall is not
// floored). The query embedding is memoized per runner process keyed by
// hash(query + model + dimensions); a failure is negative-cached for
// AMBIENT_FAILURE_TTL_MS so a provider outage does not add a full retry storm
// to every node transition. Each non-empty inject writes ONE brain_snapshots
// row per (run, query_hash, model) — trigger='ambient'; node_attempt_id is
// reserved (NULL in A) — E-12.

const log = pino({
  name: "brain:ambient",
  level: process.env.LOG_LEVEL ?? "info",
});

type AmbientDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

const MAX_CACHE = 500;
const embeddingCache = new Map<string, number[]>();

// Negative cache: after a recall/provider failure, skip ambient entirely for
// this long (per process). Keeps a provider outage from stalling every node
// transition of every opted-in run behind a full retry cycle.
export const AMBIENT_FAILURE_TTL_MS = 60_000;
let lastFailureAtMs: number | null = null;

// Test hook.
export function resetAmbientCache(): void {
  embeddingCache.clear();
  lastFailureAtMs = null;
}

function cacheKey(query: string, model: string, dimensions: number): string {
  return createHash("sha256")
    .update(`${model}:${dimensions}:${query}`)
    .digest("hex");
}

export interface AmbientArgs {
  db: AmbientDb;
  projectId: string;
  // The launch-time decision (runs.brain_context). true = ambient on.
  brainContext: boolean | null;
  taskTitle: string;
  taskPrompt: string;
  runId: string;
  nodeAttemptId?: string | null;
  // Injected in tests; the runner path resolves it from platform settings.
  client?: OpenAiCompatibleClient;
  nowMs?: number;
}

export async function getAmbientBrainProjection(
  args: AmbientArgs,
): Promise<BrainAmbientEntry[] | undefined> {
  // Opt-in: null (inherit) defaults OFF in Sub-project A.
  if (args.brainContext !== true) return undefined;
  if (!isBrainProvisioned()) return undefined;

  const nowMs = args.nowMs ?? Date.now();

  if (
    lastFailureAtMs !== null &&
    nowMs - lastFailureAtMs < AMBIENT_FAILURE_TTL_MS
  ) {
    return undefined;
  }

  try {
    // The project kill switch (ADR-122). A launch persists runs.brain_context
    // independently of projects.brain_enabled, and an admin can disable the
    // Brain AFTER a run launched opted-in, so ambient MUST re-check enablement
    // — INSIDE the try: this is a best-effort read and a transient DB error
    // must degrade to "no injection", never crash the run.
    if (!(await isProjectBrainEnabled(args.db, args.projectId))) {
      return undefined;
    }

    const client =
      args.client ??
      (await getBrainEmbeddingClient(
        args.db as unknown as Parameters<typeof getBrainEmbeddingClient>[0],
      ));
    const query = `${args.taskTitle}\n${args.taskPrompt}`.trim();

    if (!query) return undefined;

    const key = cacheKey(query, client.model, client.dimensions);
    let queryEmbedding = embeddingCache.get(key);

    if (!queryEmbedding) {
      queryEmbedding = (await client.embed([query]))[0];

      if (embeddingCache.size >= MAX_CACHE) {
        const oldest = embeddingCache.keys().next().value;

        if (oldest !== undefined) embeddingCache.delete(oldest);
      }

      embeddingCache.set(key, queryEmbedding);
    }

    const items = await recall(args.projectId, query, {
      db: args.db,
      client,
      queryEmbedding,
      limit: BRAIN_POLICY.ambientK,
      // Auto-injection floor: only items reinforced at least once (confidence₀
      // + one step). Explicit recall is deliberately NOT floored.
      minConfidence: BRAIN_POLICY.ambientMinConfidence,
    });

    if (items.length === 0) return undefined;

    // ONE ambient snapshot per (run, query_hash, model): the projection runs on
    // every node iteration with a constant query — re-writing near-identical
    // rows each time is unbounded audit noise, not evidence.
    const existing = await args.db.execute(sql`
      SELECT 1 FROM brain_snapshots
      WHERE run_id = ${args.runId} AND trigger = 'ambient'
        AND query_hash = ${queryHash(query)}
        AND embedding_model = ${client.model}
      LIMIT 1
    `);

    if (existing.rows.length === 0) {
      await writeBrainSnapshot(args.db, {
        projectId: args.projectId,
        runId: args.runId,
        nodeAttemptId: args.nodeAttemptId ?? null,
        actorType: "system",
        actorId: args.runId,
        trigger: "ambient",
        query,
        embeddingModel: client.model,
        returnedItems: items.map((i) => ({ itemId: i.id, score: i.score })),
        rankerVersion: RANKER_VERSION,
      });
    }

    return items.map((i) => ({
      kind: i.kind,
      title: i.title,
      content: i.content,
      confidence: i.confidence,
      tags: i.tags,
    }));
  } catch (err) {
    lastFailureAtMs = nowMs;
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        runId: args.runId,
      },
      "ambient brain recall failed (best-effort — run.json stays brain-less)",
    );

    return undefined;
  }
}
