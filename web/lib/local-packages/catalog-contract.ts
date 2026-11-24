import type { AdapterId } from "@/lib/acp-runners/adapter-support";

import { z } from "zod";

const bounded = z.string().min(1).max(256);
const editSession = z.string().trim().min(1).max(256);

export const catalogKind = z.enum(["skill", "mcp"]);
export type CatalogKind = z.infer<typeof catalogKind>;
export const searchQuery = z
  .object({
    kind: catalogKind,
    q: bounded,
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
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
};
export type SearchResponse = {
  results: SearchResult[];
  sources: {
    sourceId: string;
    state: "available" | "unavailable" | "rate_limited";
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
