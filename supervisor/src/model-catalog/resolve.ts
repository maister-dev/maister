import type { ModelSourceRegistry } from "./registry";

import {
  MODEL_CATALOG_TTL_SECONDS,
  type ModelCatalogDraft,
  type ModelCatalogResult,
  type ModelEntry,
  type ModelSource,
  type ResolveContext,
  type SourceStatus,
} from "./types";

type SourceOutcome = { models: ModelEntry[]; status: SourceStatus };

function errorReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;

  return typeof reason === "string" ? reason : String(reason);
}

async function runSource(
  source: ModelSource,
  draft: ModelCatalogDraft,
  ctx: ResolveContext,
): Promise<SourceOutcome> {
  try {
    return await source.resolve(draft, ctx);
  } catch (err) {
    ctx.logger.info(
      { source: source.kind, status: "error" },
      "model source failed",
    );

    return {
      models: [],
      status: { kind: source.kind, status: "error", reason: errorReason(err) },
    };
  }
}

function mergeModels(outcomes: SourceOutcome[]): ModelEntry[] {
  const byId = new Map<string, ModelEntry>();

  for (const { models } of outcomes) {
    for (const model of models) {
      const existing = byId.get(model.id);

      if (!existing) {
        byId.set(model.id, {
          id: model.id,
          ...(model.displayName !== undefined
            ? { displayName: model.displayName }
            : {}),
          origins: [...model.origins],
        });
        continue;
      }
      for (const origin of model.origins) {
        if (!existing.origins.includes(origin)) existing.origins.push(origin);
      }
    }
  }

  return [...byId.values()];
}

export async function resolveModelCatalog(
  draft: ModelCatalogDraft,
  registry: ModelSourceRegistry,
  ctx: ResolveContext,
): Promise<ModelCatalogResult> {
  const sources = registry.supporting(draft);

  ctx.logger.info(
    {
      adapter: draft.adapter,
      provider: draft.provider.kind,
      sources: sources.length,
    },
    "model catalog resolve start",
  );

  const settled = await Promise.allSettled(
    sources.map((source) => runSource(source, draft, ctx)),
  );

  const outcomes: SourceOutcome[] = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const source = sources[index];

    return {
      models: [],
      status: {
        kind: source.kind,
        status: "error",
        reason: errorReason(result.reason),
      },
    };
  });

  const models = mergeModels(outcomes);
  const statuses = outcomes.map((outcome) => outcome.status);
  const resolvedAt = new Date().toISOString();

  ctx.logger.info(
    {
      models: models.length,
      sources: statuses.map((s) => `${s.kind}:${s.status}`),
    },
    "model catalog resolve done",
  );

  return {
    models,
    sources: statuses,
    resolvedAt,
    ttlSeconds: MODEL_CATALOG_TTL_SECONDS,
  };
}
