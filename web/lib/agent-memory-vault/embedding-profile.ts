import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { toVectorLiteral } from "@/lib/brain/codec";
import { makeEmbeddingClient } from "@/lib/brain/openai-compatible";
import { getBrainSettings } from "@/lib/brain/settings";
import { MaisterError } from "@/lib/errors";

export function memoryEmbeddingsEnabled(): boolean {
  const value = process.env.MAISTER_AGENT_MEMORY_VECTOR_ENABLED;

  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new MaisterError(
    "CONFIG",
    "MAISTER_AGENT_MEMORY_VECTOR_ENABLED must be 0 or 1",
  );
}

export function memoryVectorLiteral(values: readonly number[]): string {
  if (
    !values.some((value) => Math.fround(value) !== 0) ||
    values.some((value) => !Number.isFinite(Math.fround(value)))
  )
    throw new MaisterError(
      "EMBEDDING_UNAVAILABLE",
      "Provider returned an unusable memory vector",
    );

  return toVectorLiteral([...values]);
}

export async function currentMemoryEmbeddingProfile(db: Db) {
  if (!memoryEmbeddingsEnabled())
    throw new MaisterError(
      "PRECONDITION",
      "Agent memory vector search is disabled",
    );
  const settings = await getBrainSettings(db);
  const {
    embeddingBaseUrl,
    embeddingModel,
    embeddingDimensions,
    embeddingApiKeyRef,
  } = settings;
  if (!embeddingBaseUrl || !embeddingModel || !embeddingDimensions)
    throw new MaisterError(
      "CONFIG",
      "Configure the Brain embedding provider for vector search",
    );
  const available = await db.execute<{ ready: boolean }>(sql`
    SELECT to_regclass('agent_memory_embeddings') IS NOT NULL AS ready
  `);
  if (available.rows[0]?.ready !== true)
    throw new MaisterError(
      "PRECONDITION",
      "Apply the optional vault vector migration before enabling vector search",
    );
  const client = makeEmbeddingClient({
    baseUrl: embeddingBaseUrl,
    embeddingModel,
    embeddingDimensions,
    apiKeyRef: embeddingApiKeyRef,
    distillModel: null,
  });
  const generation = createHash("sha256")
    .update(
      JSON.stringify([
        embeddingBaseUrl,
        client.model,
        client.dimensions,
        embeddingApiKeyRef,
      ]),
    )
    .digest("hex");

  return {
    client,
    model: client.model,
    dimensions: client.dimensions,
    generation,
  };
}
