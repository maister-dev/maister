"use client";

import type { z } from "zod";
import type { MutableRefObject } from "react";

import { MaisterError, isMaisterErrorCode } from "@/lib/errors-core";
import { errorCodeFromUnknown } from "@/lib/error-presentation";

export type KnowledgeDelivery = Readonly<{ input: string; key: string }>;

/** Keep an uncertain delivery's identity until its actual input changes. */
export function knowledgeDeliveryKey(
  reference: MutableRefObject<KnowledgeDelivery | null>,
  input: unknown,
): string {
  const canonical = JSON.stringify(input);

  if (reference.current?.input !== canonical)
    reference.current = { input: canonical, key: crypto.randomUUID() };

  return reference.current.key;
}

export async function sendKnowledgeRequest<T>(
  url: string,
  method: "POST" | "DELETE",
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();

  if (!response.ok) {
    const code =
      typeof payload === "object" && payload !== null && "code" in payload
        ? payload.code
        : null;

    throw new MaisterError(
      isMaisterErrorCode(code) ? code : "CRASH",
      "The native knowledge request was refused",
      typeof payload === "object" &&
        payload !== null &&
        "details" in payload &&
        typeof payload.details === "object" &&
        payload.details !== null &&
        "reason" in payload.details &&
        typeof payload.details.reason === "string"
        ? { details: { reason: payload.details.reason } }
        : undefined,
    );
  }
  const parsed = schema.safeParse(payload);

  if (!parsed.success)
    throw new MaisterError(
      "CRASH",
      "The native knowledge response does not match its contract",
    );

  return parsed.data;
}

export function knowledgeClientErrorKey(
  error: unknown,
):
  | "errorConflict"
  | "errorAccess"
  | "errorInput"
  | "errorUnknown"
  | "errorBusy"
  | "errorSize" {
  const code = errorCodeFromUnknown(error);
  const reason =
    error instanceof MaisterError ? error.details?.reason : undefined;

  if (code === "CONFLICT" && reason === "knowledge_write_busy")
    return "errorBusy";
  if (
    reason === "knowledge_body_too_large" ||
    reason === "knowledge_capture_limit" ||
    reason === "knowledge_reference_budget_exceeded"
  )
    return "errorSize";

  if (code === "CONFLICT") return "errorConflict";
  if (
    code === "UNAUTHORIZED" ||
    code === "UNAUTHENTICATED" ||
    code === "ACCOUNT_INACTIVE" ||
    code === "PASSWORD_CHANGE_REQUIRED"
  )
    return "errorAccess";
  if (code === "CONFIG" || code === "PRECONDITION") return "errorInput";

  return "errorUnknown";
}
