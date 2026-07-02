import "server-only";

import type { BrainAmbientEntry } from "@/lib/flows/graph/run-context";

import { createHash } from "node:crypto";

import { type SQL } from "drizzle-orm";
import pino from "pino";

import { isBrainProvisioned } from "./guard";
import {
  getBrainEmbeddingClient,
  type OpenAiCompatibleClient,
} from "./openai-compatible";
import { BRAIN_POLICY } from "./policy";
import { recall, writeBrainSnapshot } from "./recall";
import { RANKER_VERSION } from "./recall-ranker";

// Project Brain (ADR-122) ambient P7 injection (flow runs only). Best-effort:
// NEVER throws — a recall failure leaves run.json brain-less, it never fails the
// run. Enablement is runs.brain_context (opt-in; null = inherit flow/agent
// config, default OFF in A). The query embedding is memoized per runner process
// keyed by hash(query + model + dimensions) so the frequent per-node-attempt
// run.json rewrites do not re-embed. Each non-empty inject writes a
// brain_snapshots row (trigger='ambient', run_id + node_attempt_id) — E-12.

const log = pino({
  name: "brain:ambient",
  level: process.env.LOG_LEVEL ?? "info",
});

type AmbientDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

const MAX_CACHE = 500;
const embeddingCache = new Map<string, number[]>();

// Test hook.
export function resetAmbientCache(): void {
  embeddingCache.clear();
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
}

export async function getAmbientBrainProjection(
  args: AmbientArgs,
): Promise<BrainAmbientEntry[] | undefined> {
  // Opt-in: null (inherit) defaults OFF in Sub-project A.
  if (args.brainContext !== true) return undefined;
  if (!isBrainProvisioned()) return undefined;

  try {
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
    });

    if (items.length === 0) return undefined;

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

    return items.map((i) => ({
      kind: i.kind,
      title: i.title,
      content: i.content,
      confidence: i.confidence,
      tags: i.tags,
    }));
  } catch (err) {
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
