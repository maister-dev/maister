import type { MaisterErrorCode } from "@/lib/errors-core";

// Client-safe (no server-only): error-body reader for fetch calls against
// the web API. Translates known codes through the `apiErrors` message
// namespace so the UI branches on `code`, never on message text.
const API_ERROR_CODES = [
  "CONFIG",
  "PRECONDITION",
  "CONFLICT",
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "PASSWORD_CHANGE_REQUIRED",
  "EXECUTOR_UNAVAILABLE",
  "CRASH",
  "NOT_FOUND",
] as const satisfies readonly (MaisterErrorCode | "NOT_FOUND")[];

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export type ApiErrorBody = { code?: string; message?: string } | null;

export async function readApiErrorBody(res: Response): Promise<ApiErrorBody> {
  return (await res.json().catch(() => null)) as ApiErrorBody;
}

export function apiErrorText(body: ApiErrorBody, t: Translate): string {
  const code = body?.code;

  if (code && (API_ERROR_CODES as readonly string[]).includes(code)) {
    return t(code);
  }

  return t("requestFailed");
}

export async function readApiError(
  res: Response,
  t: Translate,
): Promise<string> {
  return apiErrorText(await readApiErrorBody(res), t);
}
