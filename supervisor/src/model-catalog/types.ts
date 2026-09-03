import type { Logger } from "pino";

import { z } from "zod";

import { ExecutorAgentSchema, RunnerProviderSchema } from "../types";

const PROVIDERS_BY_ADAPTER = {
  claude: ["anthropic", "anthropic_compatible"],
  codex: ["openai", "openai_compatible"],
  gemini: ["google_gemini", "google_vertex", "google_gateway"],
  opencode: ["agent_native"],
  mimo: ["agent_native"],
} as const;

type SourceAdapter = keyof typeof PROVIDERS_BY_ADAPTER;

function providerBelongsToAdapter(
  adapter: SourceAdapter,
  providerKind: string,
): boolean {
  return (PROVIDERS_BY_ADAPTER[adapter] as readonly string[]).includes(
    providerKind,
  );
}

export type SourceKind =
  | "acp_probe"
  | "provider_api"
  | "curated"
  | "agent_observed";

export type ModelEntry = {
  id: string;
  displayName?: string;
  origins: SourceKind[];
};

export type SourceStatus = {
  kind: SourceKind;
  status: "ok" | "skipped" | "error";
  reason?: string;
  count?: number;
};

export const ModelCatalogDraftSchema = z
  .object({
    adapter: ExecutorAgentSchema,
    provider: RunnerProviderSchema,
    force: z.boolean().optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    if (!providerBelongsToAdapter(draft.adapter, draft.provider.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider", "kind"],
        message: `provider ${draft.provider.kind} is not supported by adapter ${draft.adapter}`,
      });
    }
  });

export type ModelCatalogDraft = z.infer<typeof ModelCatalogDraftSchema>;

export type ResolveContext = { logger: Logger; signal?: AbortSignal };

export interface ModelSource {
  readonly kind: SourceKind;
  supports(draft: ModelCatalogDraft): boolean;
  resolve(
    draft: ModelCatalogDraft,
    ctx: ResolveContext,
  ): Promise<{ models: ModelEntry[]; status: SourceStatus }>;
}

export type ModelCatalogResult = {
  models: ModelEntry[];
  sources: SourceStatus[];
  resolvedAt: string;
  ttlSeconds: number;
};

export const MODEL_CATALOG_TTL_SECONDS = 3600;

export const ACP_PROBE_TIMEOUT_MS = 15_000;
