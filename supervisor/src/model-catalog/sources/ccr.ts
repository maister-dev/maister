import type { CcrManager } from "../../ccr-manager";

import {
  type ModelCatalogDraft,
  type ModelEntry,
  type ModelSource,
  type ResolveContext,
  type SourceStatus,
} from "../types";

type CcrConfig = { Providers: { name: string; models: string[] }[] };

function parseCcrConfig(raw: unknown): CcrConfig {
  if (typeof raw !== "object" || raw === null || !("Providers" in raw)) {
    throw new Error("malformed CCR config: missing Providers array");
  }
  const providers = (raw as { Providers: unknown }).Providers;

  if (!Array.isArray(providers)) {
    throw new Error("malformed CCR config: Providers is not an array");
  }
  for (const provider of providers) {
    if (
      typeof provider !== "object" ||
      provider === null ||
      typeof (provider as { name?: unknown }).name !== "string" ||
      !Array.isArray((provider as { models?: unknown }).models)
    ) {
      throw new Error("malformed CCR config: invalid provider entry");
    }
  }

  return raw as CcrConfig;
}

function flatten(config: CcrConfig): ModelEntry[] {
  const models: ModelEntry[] = [];

  for (const provider of config.Providers) {
    for (const model of provider.models) {
      models.push({ id: `${provider.name},${model}`, origins: ["ccr"] });
    }
  }

  return models;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCcrSource(
  ccrManager: CcrManager,
  opts: { fetchImpl?: typeof fetch } = {},
): ModelSource {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    kind: "ccr",
    supports: (draft) => draft.router === "ccr",
    resolve: async (draft: ModelCatalogDraft, ctx: ResolveContext) => {
      try {
        await ccrManager.ensureRunning({
          instance: draft.sidecarId ? { id: draft.sidecarId } : undefined,
        });

        const proxy = ccrManager.getProxyUrl(draft.sidecarId);
        const res = await fetchImpl(`${proxy}/api/config`, {
          signal: ctx.signal,
        });

        if (!res.ok) {
          throw new Error(`CCR /api/config returned ${res.status}`);
        }

        const models = flatten(parseCcrConfig(await res.json()));

        ctx.logger.info(
          { source: "ccr", status: "ok", count: models.length },
          "ccr model source resolved",
        );

        return {
          models,
          status: { kind: "ccr", status: "ok", count: models.length },
        };
      } catch (err) {
        const reason = errorReason(err);

        ctx.logger.info(
          { source: "ccr", status: "error" },
          "ccr model source failed",
        );

        return {
          models: [],
          status: {
            kind: "ccr",
            status: "error",
            reason,
          } satisfies SourceStatus,
        };
      }
    },
  };
}
