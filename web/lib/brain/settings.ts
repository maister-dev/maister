import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { ensureEmbeddingIndex } from "./embedding-index";
import { isBrainProvisioned } from "./guard";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

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

export const ENV_REF_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export type BrainSettingsPatch = Partial<BrainSettings>;

// Read-merge-write the platform Brain config (only patch keys apply). On a model
// OR dimension change, create the new per-generation expression index and
// enqueue a reindex job per Brain-enabled project (worker = T5.5). A runtime
// switch is a non-destructive reindex generation, never a schema migration (D4).
export async function updateBrainSettings(
  patch: BrainSettingsPatch,
  db?: SettingsDb,
): Promise<BrainSettings> {
  const handle = db ?? (getDb() as unknown as SettingsDb);
  const old = await getBrainSettings(handle);
  const merged: BrainSettings = { ...old, ...patch };

  if (
    merged.embeddingApiKeyRef &&
    !ENV_REF_RE.test(merged.embeddingApiKeyRef)
  ) {
    throw new MaisterError(
      "CONFIG",
      "embedding_api_key_ref must be an env:NAME reference (never a raw secret)",
    );
  }

  if (
    merged.embeddingDimensions != null &&
    (!Number.isInteger(merged.embeddingDimensions) ||
      merged.embeddingDimensions < 1)
  ) {
    throw new MaisterError(
      "CONFIG",
      "embedding_dimensions must be a positive integer",
    );
  }

  await handle.execute(sql`
    UPDATE platform_runtime_settings
    SET embedding_base_url = ${merged.embeddingBaseUrl},
        embedding_model = ${merged.embeddingModel},
        embedding_dimensions = ${merged.embeddingDimensions},
        embedding_api_key_ref = ${merged.embeddingApiKeyRef},
        distill_model = ${merged.distillModel},
        updated_at = now()
    WHERE id = 'singleton'
  `);

  const generationChanged =
    merged.embeddingModel !== old.embeddingModel ||
    merged.embeddingDimensions !== old.embeddingDimensions;

  if (
    generationChanged &&
    merged.embeddingModel &&
    merged.embeddingDimensions &&
    isBrainProvisioned()
  ) {
    await ensureEmbeddingIndex(
      handle,
      merged.embeddingModel,
      merged.embeddingDimensions,
    );
    // One reindex job per Brain-enabled project — the worker re-embeds active
    // items into the new generation, never mutating old rows.
    await handle.execute(sql`
      INSERT INTO brain_index_jobs (id, project_id, reason, status)
      SELECT gen_random_uuid()::text, id, 'model_switch', 'queued'
      FROM projects WHERE brain_enabled = true
    `);
  }

  return merged;
}
