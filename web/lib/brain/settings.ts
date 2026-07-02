import "server-only";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { ensureEmbeddingIndex } from "./embedding-index";
import { isBrainProvisioned } from "./guard";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

// Project Brain (ADR-122) platform embedding + distillation config, read from
// the `platform_runtime_settings` singleton (mirrors getWebhookSettings). The
// API key is stored ONLY as an `env:NAME` ref (never the value); the value is
// resolved from process.env at call time in the embedding client.

const log = pino({
  name: "brain:settings",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface BrainSettings {
  embeddingBaseUrl: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingApiKeyRef: string | null;
  distillModel: string | null;
}

type SettingsTx = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};
type SettingsDb = SettingsTx & {
  transaction?<T>(fn: (tx: SettingsTx) => Promise<T>): Promise<T>;
};

function rowToSettings(
  row: Record<string, unknown> | undefined,
): BrainSettings {
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

const SETTINGS_SELECT = sql`
  SELECT embedding_base_url, embedding_model, embedding_dimensions,
         embedding_api_key_ref, distill_model
  FROM platform_runtime_settings WHERE id = 'singleton'
`;

export async function getBrainSettings(
  db?: SettingsDb,
): Promise<BrainSettings> {
  const handle = db ?? (getDb() as unknown as SettingsDb);
  const r = await handle.execute(SETTINGS_SELECT);

  return rowToSettings((r.rows ?? [])[0]);
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

// pgvector HNSW indexes support at most 2000 dimensions — a larger value would
// pass the settings write and then fail index DDL, stranding the generation.
export const MAX_EMBEDDING_DIMENSIONS = 2000;

export type BrainSettingsPatch = Partial<BrainSettings>;

// Enqueue a reindex job for every Brain-enabled project (or one project) that
// has active items missing current-generation embeddings and no live job. This
// is BOTH the generation-switch enqueue and the recovery path: a `failed` job
// is neither queued nor running, so the next settings save / project enable
// re-admits the project. Returns the number of jobs created.
async function insertReconcileJobs(
  exec: SettingsTx,
  model: string,
  dimensions: number,
  reason: "model_switch" | "manual",
  projectId?: string,
): Promise<number> {
  const projectClause = projectId ? sql` AND p.id = ${projectId}` : sql``;
  const r = await exec.execute(sql`
    INSERT INTO brain_index_jobs (id, project_id, reason, status)
    SELECT gen_random_uuid()::text, p.id, ${reason}, 'queued'
    FROM projects p
    WHERE p.brain_enabled = true${projectClause}
      AND NOT EXISTS (
        SELECT 1 FROM brain_index_jobs j
        WHERE j.project_id = p.id AND j.status IN ('queued', 'running')
      )
      AND EXISTS (
        SELECT 1 FROM brain_items i
        WHERE i.project_id = p.id AND i.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM brain_embeddings e
            WHERE e.item_id = i.id
              AND e.embedding_model = ${model}
              AND e.embedding_dimensions = ${dimensions}
          )
      )
    RETURNING id
  `);

  return r.rows.length;
}

// Public reconcile entry (project brain-enable path): reads the live config and
// enqueues coverage-gap jobs. No-op when the embedding config is absent or the
// Brain is not provisioned.
export async function reconcileBrainIndexJobs(
  db: SettingsDb,
  opts: { projectId?: string; reason?: "model_switch" | "manual" } = {},
): Promise<number> {
  if (!isBrainProvisioned()) return 0;

  const s = await getBrainSettings(db);

  if (!isEmbeddingConfigured(s)) return 0;

  return insertReconcileJobs(
    db,
    s.embeddingModel as string,
    s.embeddingDimensions as number,
    opts.reason ?? "manual",
    opts.projectId,
  );
}

// Merge-write the platform Brain config in ONE transaction with the singleton
// row locked (concurrent admin PATCHes serialize — no lost update, and
// `generationChanged` is computed against the locked row, never a stale read).
// The reconcile enqueue commits atomically WITH the settings write, so a crash
// can never leave a switched generation with zero jobs. The HNSW expression
// index is asserted AFTER commit (idempotent; the reindex sweep re-asserts it
// as a belt every tick, so a failure here only delays, never strands).
export async function updateBrainSettings(
  patch: BrainSettingsPatch,
  db?: SettingsDb,
): Promise<BrainSettings> {
  const handle = db ?? (getDb() as unknown as SettingsDb);

  const apply = async (tx: SettingsTx): Promise<BrainSettings> => {
    const locked = await tx.execute(
      sql`SELECT embedding_base_url, embedding_model, embedding_dimensions,
                 embedding_api_key_ref, distill_model
          FROM platform_runtime_settings WHERE id = 'singleton' FOR UPDATE`,
    );
    const old = rowToSettings((locked.rows ?? [])[0]);
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
        merged.embeddingDimensions < 1 ||
        merged.embeddingDimensions > MAX_EMBEDDING_DIMENSIONS)
    ) {
      throw new MaisterError(
        "CONFIG",
        `embedding_dimensions must be an integer in 1..${MAX_EMBEDDING_DIMENSIONS} (pgvector HNSW cap)`,
      );
    }

    await tx.execute(sql`
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
      merged.embeddingModel &&
      merged.embeddingDimensions &&
      isBrainProvisioned()
    ) {
      await insertReconcileJobs(
        tx,
        merged.embeddingModel,
        merged.embeddingDimensions,
        generationChanged ? "model_switch" : "manual",
      );
    }

    return merged;
  };

  const merged =
    typeof handle.transaction === "function"
      ? await handle.transaction(apply)
      : await apply(handle);

  if (
    merged.embeddingModel &&
    merged.embeddingDimensions &&
    isBrainProvisioned()
  ) {
    try {
      await ensureEmbeddingIndex(
        handle,
        merged.embeddingModel,
        merged.embeddingDimensions,
      );
    } catch (err) {
      // Settings + jobs are committed; the reindex sweep re-asserts the index
      // every tick, so this only delays vector recall for the new generation.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "brain settings saved but HNSW index creation failed — the reindex sweep will retry",
      );
    }
  }

  return merged;
}
