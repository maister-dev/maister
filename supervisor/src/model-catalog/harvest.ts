import type { Logger } from "pino";
import type * as acp from "@agentclientprotocol/sdk";
import type { RunnerLaunch } from "../types";
import type { ModelCatalogCache } from "./cache";

import { mergeModels } from "./resolve";
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

// Passive harvest (ADR-076): feed the model state observed on a REAL session's
// session/new or session/resume response into the shared cache, tagged
// `agent_observed`. Best-effort and side-effect-free on the live path — it MUST
// NEVER throw into the session flow (a harvest failure is swallowed at debug).
export function harvestSessionModels(
  runner: RunnerLaunch | undefined,
  models: acp.SessionModelState | null | undefined,
  cache: ModelCatalogCache,
  logger: Logger,
): void {
  // Optional-chain the whole path: the wire is unvalidated (the ACP SDK has no
  // response schema), so `models` may be malformed — a throw here would fail
  // the session spawn.
  if (!runner || !models?.availableModels?.length) return;

  try {
    const observed: ModelEntry[] = models.availableModels.map((m) => ({
      id: m.modelId,
      ...(m.name ? { displayName: m.name } : {}),
      origins: ["agent_observed" as const],
    }));

    // MERGE into any live cached catalog, never replace it: a real session only
    // exposes its adapter's availableModels, usually a SUBSET of the resolved
    // probe/provider/curated set. A plain set() would shrink the catalog (and the
    // suggestions UI) for the full TTL. setMerged preserves the entry's TTL window
    // so this enrichment never resurrects an already-stale row.
    cache.setMerged(draftFromRunner(runner), (prev) => ({
      models: mergeModels([
        ...(prev ? [{ models: prev.models }] : []),
        { models: observed },
      ]),
      sources: [
        ...(prev?.sources ?? []).filter((s) => s.kind !== "agent_observed"),
        { kind: "agent_observed", status: "ok", count: observed.length },
      ],
      resolvedAt: new Date().toISOString(),
      ttlSeconds: MODEL_CATALOG_TTL_SECONDS,
    }));
    logger.info(
      { source: "agent_observed", count: observed.length },
      "model harvest",
    );
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "model harvest skipped",
    );
  }
}
