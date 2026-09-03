import { ModelSourceRegistry } from "../registry";

import { createAcpProbeSource } from "./acp-probe";
import { createCuratedSource } from "./curated";
import { createProviderApiSource } from "./provider-api";

// Assemble the production model-catalog source set (ADR-076). Order is the
// dedupe priority (first-source-wins on the entry body; origins still
// accumulate): the ACP active probe is the primary source, then the curated
// GLM list (the offline source of truth for z.ai), then the optional provider
// listing API.
export function createDefaultModelSourceRegistry(): ModelSourceRegistry {
  return new ModelSourceRegistry([
    createAcpProbeSource(),
    createCuratedSource(),
    createProviderApiSource(),
  ]);
}
