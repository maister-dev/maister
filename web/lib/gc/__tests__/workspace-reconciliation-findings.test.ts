import { describe, expect, it } from "vitest";

import {
  MAX_RECONCILIATION_ATTEMPTS,
  nextReconciliationRetryAt,
  reconciliationFindingId,
  reconciliationObservationFingerprint,
  reconciliationRetryDelayMs,
  type ReconciliationObservation,
} from "../workspace-reconciliation-findings";

const observation: ReconciliationObservation = {
  candidateKind: "rowless_managed",
  relativePath: "project/run-1",
  provenanceVersion: 2,
  provenanceFingerprint: "provenance-fingerprint",
  provenanceRunId: "run-1",
  projectId: "project-1",
  runId: null,
  workspaceId: null,
};

describe("workspace reconciliation finding policy", () => {
  it("uses a deterministic identity without storing an absolute filesystem path", () => {
    const first = reconciliationFindingId(observation);
    const second = reconciliationFindingId({ ...observation });

    expect(first).toBe(second);
    expect(first).toMatch(/^wrf_[0-9a-f]{40}$/);
    expect(reconciliationObservationFingerprint(observation)).not.toContain(
      "/Users/",
    );
  });

  it("caps exponential retry delay at one day", () => {
    const firstDelay = reconciliationRetryDelayMs(1);
    const laterDelay = reconciliationRetryDelayMs(MAX_RECONCILIATION_ATTEMPTS);
    const retryAt = nextReconciliationRetryAt({
      now: new Date("2026-07-16T12:00:00.000Z"),
      attemptCount: 1,
    });

    expect(firstDelay).toBe(5 * 60_000);
    expect(laterDelay).toBeLessThanOrEqual(24 * 60 * 60_000);
    expect(retryAt).toEqual(new Date("2026-07-16T12:05:00.000Z"));
  });
});
