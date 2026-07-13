import type { MaisterErrorCode } from "@/lib/errors-core";

import { isMaisterErrorCode } from "@/lib/errors-core";

export function errorCodeFromUnknown(error: unknown): MaisterErrorCode | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const { code } = error as { code?: unknown };

  return isMaisterErrorCode(code) ? code : null;
}
