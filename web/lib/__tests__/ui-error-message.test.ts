import { describe, expect, it } from "vitest";

import {
  isMaisterErrorCode,
  resolveUiErrorMessageKey,
} from "@/lib/ui-error-message";

describe("UI error-message resolver", () => {
  it.each([
    "PRECONDITION",
    "SPAWN",
    "NEEDS_INPUT",
    "HITL_TIMEOUT",
    "CRASH",
    "CONFLICT",
    "CONFIG",
    "EXECUTOR_UNAVAILABLE",
    "FLOW_INSTALL",
    "ACP_PROTOCOL",
    "CHECKPOINT",
    "BUDGET_EXCEEDED",
    "EMBEDDING_UNAVAILABLE",
    "STEP_CHECKPOINTED",
    "UNAUTHENTICATED",
    "UNAUTHORIZED",
    "PASSWORD_CHANGE_REQUIRED",
    "ACCOUNT_INACTIVE",
  ])("maps known code %s to its run translation key", (code) => {
    expect(resolveUiErrorMessageKey(code)).toBe(`error.${code}`);
    expect(isMaisterErrorCode(code)).toBe(true);
  });

  it.each([undefined, null, "NOT_A_CODE", 503, { code: "CRASH" }])(
    "uses the safe generic key for malformed code %#",
    (code) => {
      expect(resolveUiErrorMessageKey(code)).toBe("error.generic");
      expect(isMaisterErrorCode(code)).toBe(false);
    },
  );
});
