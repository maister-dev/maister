import "server-only";

import type { NextResponse } from "next/server";
import type { VaultMutationResult } from "./store";

import { MAX_VAULT_COMMAND_BYTES } from "./limits";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { httpStatusForAuthz } from "@/lib/authz";
import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";

export function readVaultJson(request: Request): Promise<unknown> {
  return readBoundedJson(request, MAX_VAULT_COMMAND_BYTES, {
    contentType: "This request requires application/json",
    missing: "A memory command body is required",
    tooLarge: "The memory command exceeds its byte limit",
    tooLargeReason: "json_body_too_large",
    invalid: "The memory command must be valid UTF-8 JSON",
  });
}

export function vaultMutationResponse(
  result: VaultMutationResult,
): NextResponse {
  if (result.status === "applied") return privateJson(result);
  if (result.status === "pending") return privateJson(result, 202);

  const { current, mismatches } = result;

  return privateJson(
    {
      code: "CONFLICT",
      message: "Memory changed since it was loaded",
      ...(current && { current }),
      ...(mismatches && { mismatches }),
    },
    409,
  );
}

export function vaultErrorResponse(
  error: unknown,
  route: string,
): NextResponse {
  if (!isMaisterError(error))
    return privateErrorResponse(redactQueryError(error), route);
  if (error.code === "EMBEDDING_UNAVAILABLE")
    return privateJson(
      { code: error.code, message: "Memory embedding is unavailable" },
      503,
    );
  const status = httpStatusForAuthz(error.code);

  if (status !== null)
    return privateJson(
      {
        code: status === 401 ? "UNAUTHENTICATED" : "UNAUTHORIZED",
        message: error.message,
      },
      status,
    );
  if (error.code === "CONFIG")
    return privateJson(
      {
        code: error.code,
        message: error.message,
      },
      error.details?.reason === "json_body_too_large" ? 413 : 422,
    );
  if (error.code === "PRECONDITION" || error.code === "CONFLICT")
    return privateJson(
      {
        code: error.code,
        message: error.message,
      },
      error.details?.reason === "agent_memory_unavailable" ? 404 : 409,
    );

  return privateErrorResponse(error, route);
}
