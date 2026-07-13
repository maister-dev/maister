import { isMaisterErrorCode } from "@/lib/errors-core";

export { isMaisterErrorCode } from "@/lib/errors-core";

export type UiErrorMessageKey = `error.${string}`;

export function resolveUiErrorMessageKey(value: unknown): UiErrorMessageKey {
  return isMaisterErrorCode(value) ? `error.${value}` : "error.generic";
}
