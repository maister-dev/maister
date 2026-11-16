import "server-only";

import type { KnowledgePrincipal } from "./knowledge-types";
import type { NextResponse } from "next/server";

import {
  privateErrorResponse,
  privateJson,
  readPrivateJson,
} from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";

export async function knowledgeSessionPrincipal(): Promise<KnowledgePrincipal> {
  return { kind: "user", userId: (await requireActiveSession()).id };
}

export function knowledgeJson(value: unknown, status = 200): NextResponse {
  return privateJson(value, status);
}

export function knowledgeErrorResponse(
  error: unknown,
  route: string,
): NextResponse {
  return privateErrorResponse(error, route);
}

export async function readKnowledgeJson(request: Request): Promise<unknown> {
  return readPrivateJson(request, {
    contentType: "Native knowledge writes require application/json",
    missing: "A native knowledge JSON body is required",
    tooLarge: "Native knowledge body exceeds its byte limit",
    tooLargeReason: "knowledge_body_too_large",
    invalid: "Native knowledge body must be valid UTF-8 JSON",
  });
}
