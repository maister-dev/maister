import type { AdapterId } from "@/lib/acp-runners/adapter-support";

import { z } from "zod";

const bounded = z.string().min(1).max(256);
const editSession = z.string().trim().min(1).max(256);

export const catalogKind = z.enum(["skill", "mcp"]);
export type CatalogKind = z.infer<typeof catalogKind>;
const catalogFailureReason = z.enum([
  "approval_revoked",
  "upstream_access_denied",
  "catalog_identity_unavailable",
  "preview_limit_reached",
  "remote_requirements_unsupported",
  "distribution_requirements_unsupported",
  "origin_changed",
  "already_imported",
  "skill_id_exists",
  "mcp_ref_exists",
  "mcp_descriptor_diverged",
  "destination_occupied",
  "request_key_reused",
  "draft_changed",
  "resolutions_required",
]);

export const catalogRequirementName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/);
export const maxCatalogRequirementNames = 8;
const catalogRequirements = z.object({
  names: z.array(catalogRequirementName).max(maxCatalogRequirementNames),
  more: z.boolean(),
});

export type CatalogRequirements = z.infer<typeof catalogRequirements>;
export const catalogFailureDetails = z.object({
  reason: catalogFailureReason,
  headers: catalogRequirements.optional(),
  urlVariables: catalogRequirements.optional(),
  environmentVariables: catalogRequirements.optional(),
});
export type CatalogFailureDetails = z.infer<typeof catalogFailureDetails>;
export const searchQuery = z
  .object({
    kind: catalogKind,
    q: bounded,
    cursor: z.string().min(1).max(2048).optional(),
    scope: z.enum(["skills.sh", "repositories"]).optional(),
  })
  .strict()
  .refine((query) => query.kind === "skill" || !query.scope, {
    path: ["scope"],
    message: "Catalog search scope is supported for skills only",
  });
export type SearchQuery = z.infer<typeof searchQuery>;
export const previewBody = z
  .object({
    sessionId: editSession,
    kind: catalogKind,
    sourceId: bounded,
    selector: z.string().min(1).max(2048),
    destination: z.string().min(1).max(512),
    importId: bounded.optional(),
  })
  .strict();
export const applyBody = z
  .object({
    sessionId: editSession,
    previewId: z.string().uuid(),
    expectedDraftBase: z.string().regex(/^[a-f0-9]{64}$/),
    requestKey: z.string().min(1).max(128),
    resolutions: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            use: z.enum(["upstream", "draft"]),
          })
          .strict(),
      )
      .max(256)
      .optional(),
  })
  .strict();
export type SearchResult = {
  sourceId: string;
  resultId: string;
  publisher: string;
  name: string;
  kind: CatalogKind;
  canonicalSkillId?: string;
};
export type SearchResponse = {
  results: SearchResult[];
  sources: {
    sourceId: string;
    state: "available" | "unavailable" | "rate_limited";
    reason?: Extract<
      CatalogFailureDetails["reason"],
      "catalog_identity_unavailable"
    >;
  }[];
  nextCursor: string | null;
};
export type ReviewFile = {
  path: string;
  change: "add" | "modify" | "remove" | "conflict" | "local";
  digest: string | null;
  before: string | null;
  after: string | null;
};
export type CatalogPreview = {
  previewId: string;
  importId: string;
  pin: string;
  digest: string;
  artifactDigest: string | null;
  expectedDraftBase: string;
  files: ReviewFile[];
  affectedRefs: string[];
  notices: string[];
  configuration: string[];
  migratesLegacyManifest?: boolean;
  runnerCompatibility: {
    transport: "stdio" | "http";
    compatibleAdapters: AdapterId[];
  } | null;
  expiresAt: string;
  publisher: string;
  sourceUrl: string;
  destination: string;
};
export type CatalogAbortReason = "draft_changed" | "approval_revoked";
export type CatalogReceipt = { operationId: string } & (
  | { state: "pending" }
  | { state: "applied"; draftDigest: string }
  | { state: "aborted"; reason: CatalogAbortReason }
);
