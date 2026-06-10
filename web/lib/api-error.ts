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

export async function readApiError(
  res: Response,
  t: Translate,
): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;
  const code = body?.code;

  if (code && (API_ERROR_CODES as readonly string[]).includes(code)) {
    // Keep the server detail (cron validation text, conflicting state, …)
    // behind the translated label — the detail is technical, the label is UX.
    return body?.message ? `${t(code)} — ${body.message}` : t(code);
  }

  return body?.message ?? code ?? t("requestFailed", { status: res.status });
}
