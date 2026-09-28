import { describe, expect, it } from "vitest";

import {
  isMaisterErrorCode,
  isStaleViewErrorCode,
  resolveHitlErrorMessage,
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

// ADR-177 amendment 2026-09-26 (D-G2): the two host-named reasons.
describe("the dead-session respond reasons", () => {
  it("session_ended is a CONFLICT, with scratch copy on the scratch surface", () => {
    const body = { code: "CONFLICT", details: { reason: "session_ended" } };

    expect(resolveHitlErrorMessage(body)).toEqual({
      key: "errorReasons.session_ended",
    });
    expect(resolveHitlErrorMessage({ ...body, surface: "scratch" })).toEqual({
      key: "errorReasons.session_ended_scratch",
    });
  });

  it("permission_not_pending is a HITL_TIMEOUT on every surface", () => {
    const body = {
      code: "HITL_TIMEOUT",
      details: { reason: "permission_not_pending" },
    };

    expect(resolveHitlErrorMessage(body)).toEqual({
      key: "errorReasons.permission_not_pending",
    });
    expect(resolveHitlErrorMessage({ ...body, surface: "scratch" })).toEqual({
      key: "errorReasons.permission_not_pending",
    });
  });

  it("a reason under the wrong code is never trusted", () => {
    expect(
      resolveHitlErrorMessage({
        code: "HITL_TIMEOUT",
        details: { reason: "session_ended" },
      }),
    ).toEqual({ key: "error.HITL_TIMEOUT" });
  });
});
