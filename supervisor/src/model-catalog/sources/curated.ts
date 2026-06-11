import type {
  ModelCatalogDraft,
  ModelEntry,
  ModelSource,
  ResolveContext,
} from "../types";

// ADR-075 §3: z.ai has no listing endpoint (verified), so this static GLM list
// is the source of truth for the anthropic_compatible provider kind. Ordered as
// shown in the runner modal.
const CURATED_GLM_MODELS: ReadonlyArray<{ id: string; displayName: string }> = [
  { id: "glm-5.1", displayName: "GLM-5.1" },
  { id: "glm-5", displayName: "GLM-5" },
  { id: "glm-5-turbo", displayName: "GLM-5-Turbo" },
  { id: "glm-4.7", displayName: "GLM-4.7" },
  { id: "glm-4.5-air", displayName: "GLM-4.5-air" },
];

export function createCuratedSource(): ModelSource {
  return {
    kind: "curated",
    // Direct (non-CCR) z.ai only — a CCR-routed runner's model namespace is
    // CCR's "provider,model" format (the CCR source's job), not direct GLM ids.
    supports: (draft: ModelCatalogDraft) =>
      draft.provider.kind === "anthropic_compatible" && draft.router !== "ccr",
    resolve: async (_draft: ModelCatalogDraft, ctx: ResolveContext) => {
      const models: ModelEntry[] = CURATED_GLM_MODELS.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        origins: ["curated"],
      }));

      ctx.logger.info(
        { source: "curated", status: "ok", count: models.length },
        "model source resolved",
      );

      return {
        models,
        status: {
          kind: "curated" as const,
          status: "ok" as const,
          count: models.length,
        },
      };
    },
  };
}
