import type { CcrManager } from "../../ccr-manager";

import { ModelSourceRegistry } from "../registry";

import { createAcpProbeSource } from "./acp-probe";
import { createCcrSource } from "./ccr";
import { createCuratedSource } from "./curated";
import { createProviderApiSource } from "./provider-api";

// Assemble the production model-catalog source set (ADR-073). Order is the
// dedupe priority (first-source-wins on the entry body; origins still
// accumulate): the ACP active probe is the primary source, then the curated
// GLM list (the offline source of truth for z.ai), the optional provider
// listing API, and the CCR proxy (router=ccr drafts only).
export function createDefaultModelSourceRegistry(
  ccrManager: CcrManager,
): ModelSourceRegistry {
  return new ModelSourceRegistry([
    createAcpProbeSource(),
    createCuratedSource(),
    createProviderApiSource(),
    createCcrSource(ccrManager),
  ]);
}
