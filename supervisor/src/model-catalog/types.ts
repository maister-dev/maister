import type { Logger } from "pino";

import { z } from "zod";

import {
  ExecutorAgentSchema,
  ExecutorRouterSchema,
  RunnerProviderSchema,
} from "../types";

export type SourceKind =
  | "acp_probe"
  | "provider_api"
  | "curated"
  | "ccr"
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
    router: ExecutorRouterSchema.optional(),
    sidecarId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    // ADR-076 edge case: a router selects a sidecar instance, so `router`
    // without `sidecarId` is a malformed draft → PRECONDITION (409).
    if (draft.router && !draft.sidecarId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sidecarId"],
        message: "sidecarId is required when router is set",
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
