import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import type { AssignmentControlOutcome } from "./controls";

import { privateJson } from "@/lib/api/private-json";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";
import { MaisterError } from "@/lib/errors";

/** Reads the `cursor`/`limit` page selector; the domain schema bounds the values. */
export function assignmentPageQuery(
  request: NextRequest,
): Readonly<{ cursor?: string; limit?: string }> {
  const params = request.nextUrl.searchParams;

  requireKnowledgeQueryKeys(params, ["cursor", "limit"]);
  const limit = params.get("limit");

  if (limit !== null && !/^[1-9][0-9]*$/.test(limit))
    throw new MaisterError("CONFIG", "Invalid assignment pagination query");

  return {
    ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    ...(limit ? { limit } : {}),
  };
}

/** Pending intent stays HTTP 202, including on exact replay. */
export function assignmentControlResponse(
  outcome: AssignmentControlOutcome,
): NextResponse {
  return privateJson(outcome.receipt, outcome.settled ? 200 : 202);
}
