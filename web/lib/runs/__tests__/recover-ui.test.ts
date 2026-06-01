// M19 Phase 5: pure mapping from the POST /api/runs/[runId]/recover HTTP status
// to the client UI state the RunRecoverActions component branches on. The route
// emits 200 (resumed/redispatched), 202 (queued — cap full), 409 (conflict /
// discard-only), 410 (unresumable), 503 (transient); anything else is a generic
// error. This is the single source of truth so the component never string-matches.

import { describe, expect, it } from "vitest";

import { recoverHttpToUiState } from "@/lib/runs/recover-ui";

describe("recoverHttpToUiState — recover HTTP status → UI state", () => {
  it("200 → resumed", () => {
    expect(recoverHttpToUiState(200)).toBe("resumed");
  });

  it("202 → queued (cap full, waiting for capacity)", () => {
    expect(recoverHttpToUiState(202)).toBe("queued");
  });

  it("409 → conflict", () => {
    expect(recoverHttpToUiState(409)).toBe("conflict");
  });

  it("410 → gone", () => {
    expect(recoverHttpToUiState(410)).toBe("gone");
  });

  it("503 → retry", () => {
    expect(recoverHttpToUiState(503)).toBe("retry");
  });

  it("500 → error", () => {
    expect(recoverHttpToUiState(500)).toBe("error");
  });

  it("401 (unmapped) → error", () => {
    expect(recoverHttpToUiState(401)).toBe("error");
  });

  it("404 (unmapped) → error", () => {
    expect(recoverHttpToUiState(404)).toBe("error");
  });

  it("0 (network failure sentinel) → error", () => {
    expect(recoverHttpToUiState(0)).toBe("error");
  });

  it.each([200, 202, 409, 410, 503])(
    "%i maps to a non-error state",
    (status) => {
      expect(recoverHttpToUiState(status)).not.toBe("error");
    },
  );
});
