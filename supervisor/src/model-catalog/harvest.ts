import type { Logger } from "pino";
import type * as acp from "@agentclientprotocol/sdk";
import type { RunnerLaunch } from "../types";
import type { ModelCatalogCache } from "./cache";

import {
  MODEL_CATALOG_TTL_SECONDS,
  type ModelCatalogDraft,
  type ModelEntry,
} from "./types";

// Derive the resolve-equivalent draft from a launched runner so a passive
// harvest writes the SAME cache key a `/model-catalog/resolve` request for that
// runner would read. provider (with its bare env-ref names + base URL) is
// reused verbatim; a CCR sidecar maps to router="ccr" + its id.
export function draftFromRunner(runner: RunnerLaunch): ModelCatalogDraft {
  return {
    adapter: runner.adapter,
    provider: runner.provider,
    ...(runner.sidecar
      ? { router: "ccr" as const, sidecarId: runner.sidecar.id }
      : {}),
  };
}

// Passive harvest (ADR-073): feed the model state observed on a REAL session's
// session/new or session/resume response into the shared cache, tagged
// `agent_observed`. Best-effort and side-effect-free on the live path — it MUST
// NEVER throw into the session flow (a harvest failure is swallowed at debug).
export function harvestSessionModels(
  runner: RunnerLaunch | undefined,
  models: acp.SessionModelState | null | undefined,
  cache: ModelCatalogCache,
  logger: Logger,
): void {
  if (!runner || !models || models.availableModels.length === 0) return;

  try {
    const entries: ModelEntry[] = models.availableModels.map((m) => ({
      id: m.modelId,
      ...(m.name ? { displayName: m.name } : {}),
      origins: ["agent_observed" as const],
    }));

    cache.set(draftFromRunner(runner), {
      models: entries,
      sources: [
        { kind: "agent_observed", status: "ok", count: entries.length },
      ],
      resolvedAt: new Date().toISOString(),
      ttlSeconds: MODEL_CATALOG_TTL_SECONDS,
    });
    logger.info(
      { source: "agent_observed", count: entries.length },
      "model harvest",
    );
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "model harvest skipped",
    );
  }
}
