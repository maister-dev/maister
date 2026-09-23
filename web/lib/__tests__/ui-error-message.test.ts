import { describe, expect, it } from "vitest";

import {
  isMaisterErrorCode,
  isStaleViewErrorCode,
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

  it("preserves the generic executor copy outside the HITL surface", () => {
    expect(isMaisterErrorCode("EXECUTOR_UNAVAILABLE")).toBe(true);
    expect(resolveUiErrorMessageKey("EXECUTOR_UNAVAILABLE")).toBe(
      "error.EXECUTOR_UNAVAILABLE",
    );
  });

  it.each([undefined, null, "NOT_A_CODE", 503, { code: "CRASH" }])(
    "uses the safe generic key for malformed code %#",
    (code) => {
      expect(resolveUiErrorMessageKey(code)).toBe("error.generic");
      expect(isMaisterErrorCode(code)).toBe(false);
    },
  );
});

describe("stale-view error codes", () => {
  it.each(["CONFLICT", "PRECONDITION", "HITL_TIMEOUT"])(
    "treats %s as a refusal the rendered view cannot survive",
    (code) => {
      expect(isStaleViewErrorCode(code)).toBe(true);
    },
  );

  // Retryable and validation refusals leave the view current and the caller's
  // entered payload valid — re-syncing there would be noise, not a fix.
  it.each([
    "EXECUTOR_UNAVAILABLE",
    "NEEDS_INPUT",
    "CONFIG",
    "CRASH",
    "ACP_PROTOCOL",
    undefined,
    null,
    409,
  ])("leaves the view alone for %s", (code) => {
    expect(isStaleViewErrorCode(code)).toBe(false);
  });
});
