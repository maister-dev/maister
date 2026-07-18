// Client-safe fetch helper for the Evaluation Lab surfaces. Every mutation
// goes through `evalRequest`, which reduces a non-ok `{code,message}` route
// body to a typed EvalApiError. Components branch on `code` / translate via
// `evalErrorKey` + the `evaluationsErrors` namespace — a raw server message
// (including Zod JSON) never reaches the UI.
import { isMaisterErrorCode, type MaisterErrorCode } from "@/lib/errors-core";

// The codes the evaluation routes emit (see lib/evaluations/route-helpers.ts
// `evalStatusForCode`) that carry their own localized copy. CONFLICT is the
// If-Match / concurrency case and gets dedicated copy.
const TRANSLATED_CODES = [
  "CONFIG",
  "PRECONDITION",
  "CONFLICT",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "EXECUTOR_UNAVAILABLE",
  "CRASH",
] as const satisfies readonly MaisterErrorCode[];

export type EvalErrorKey = (typeof TRANSLATED_CODES)[number] | "generic";

export class EvalApiError extends Error {
  readonly code: MaisterErrorCode | null;

  constructor(code: MaisterErrorCode | null) {
    super(code ?? "UNKNOWN");
    this.name = "EvalApiError";
    this.code = code;
  }
}

// The `evaluationsErrors` message key for a caught mutation failure.
export function evalErrorKey(err: unknown): EvalErrorKey {
  if (
    err instanceof EvalApiError &&
    err.code !== null &&
    (TRANSLATED_CODES as readonly string[]).includes(err.code)
  ) {
    return err.code as EvalErrorKey;
  }

  return "generic";
}

export async function evalRequest(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let res: Response;

  try {
    res = await fetch(url, init);
  } catch {
    throw new EvalApiError(null);
  }

  if (res.ok) return res;

  const body = (await res.json().catch(() => null)) as {
    code?: unknown;
  } | null;

  throw new EvalApiError(isMaisterErrorCode(body?.code) ? body.code : null);
}
