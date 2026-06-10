import "server-only";

import type { ReviewComment } from "./service";

// ADR-071 shared wire helpers for the review-comment route family
// (collection + item routes): the OpenAPI ReviewComment DTO projection and
// the MaisterError-code → HTTP-status map. Kept here (not lib/errors.ts)
// because the map is route-family policy: e.g. the catalog routes map
// CONFIG → 422 while this family's OpenAPI mandates CONFIG → 400.

// Explicit OpenAPI ReviewComment wire DTO — never the raw row (dates become
// ISO strings; exactly the documented fields).
export interface ReviewCommentDto {
  id: string;
  runId: string;
  hitlRequestId: string;
  nodeId: string;
  gateAttempt: number;
  parentId: string | null;
  authorUserId: string | null;
  authorLabel: string;
  filePath: string | null;
  side: "old" | "new" | null;
  line: number | null;
  lineContent: string | null;
  body: string;
  status: "open" | "resolved";
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export function toCommentDto(row: ReviewComment): ReviewCommentDto {
  return {
    id: row.id,
    runId: row.runId,
    hitlRequestId: row.hitlRequestId,
    nodeId: row.nodeId,
    gateAttempt: row.gateAttempt,
    parentId: row.parentId,
    authorUserId: row.authorUserId,
    authorLabel: row.authorLabel,
    filePath: row.filePath,
    side: row.side,
    line: row.line,
    lineContent: row.lineContent,
    body: row.body,
    status: row.status,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}
