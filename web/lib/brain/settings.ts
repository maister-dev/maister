import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db/client";

// Project Brain (ADR-122) platform embedding + distillation config, read from
// the `platform_runtime_settings` singleton (mirrors getWebhookSettings). The
// API key is stored ONLY as an `env:NAME` ref (never the value); the value is
// resolved from process.env at call time in the embedding client.

export interface BrainSettings {
  embeddingBaseUrl: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingApiKeyRef: string | null;
  distillModel: string | null;
}

type SettingsDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export async function getBrainSettings(
  db?: SettingsDb,
): Promise<BrainSettings> {
  const handle = db ?? (getDb() as unknown as SettingsDb);
  const r = await handle.execute(sql`
    SELECT embedding_base_url, embedding_model, embedding_dimensions,
           embedding_api_key_ref, distill_model
    FROM platform_runtime_settings WHERE id = 'singleton'
  `);
  const row = (r.rows ?? [])[0] as Record<string, unknown> | undefined;

  return {
    embeddingBaseUrl: (row?.embedding_base_url as string | null) ?? null,
    embeddingModel: (row?.embedding_model as string | null) ?? null,
    embeddingDimensions:
      row?.embedding_dimensions != null
        ? Number(row.embedding_dimensions)
        : null,
    embeddingApiKeyRef: (row?.embedding_api_key_ref as string | null) ?? null,
    distillModel: (row?.distill_model as string | null) ?? null,
  };
}

// Embedding config alone (base URL + model + dimensions) — enough to recall/embed.
export function isEmbeddingConfigured(s: BrainSettings): boolean {
  return Boolean(
    s.embeddingBaseUrl && s.embeddingModel && s.embeddingDimensions,
  );
}

// The enable-gate contract (T5.2): a project may only be enabled when BOTH the
// embedding config AND the distillation model are set — so harvest never runs
// unconfigured by construction.
export function isBrainFullyConfigured(s: BrainSettings): boolean {
  return isEmbeddingConfigured(s) && Boolean(s.distillModel);
}
