import { describe, expect, it } from "vitest";

import {
  EXTERNAL_GATE_READY_STATUSES,
  collapseLatestExternalPerGate,
  isExternalGateReady,
} from "@/lib/flows/graph/external-gate-readiness";

type Row = { id: string; gateId: string; runId: string; createdAt: Date };

function row(id: string, gateId: string, runId: string, iso: string): Row {
  return { id, gateId, runId, createdAt: new Date(iso) };
}

describe("isExternalGateReady / EXTERNAL_GATE_READY_STATUSES", () => {
  it("is an allow-list of passed + overridden only", () => {
    expect([...EXTERNAL_GATE_READY_STATUSES].sort()).toEqual([
      "overridden",
      "passed",
    ]);
  });

  it.each(["passed", "overridden"])("ready: %s", (s) => {
    expect(isExternalGateReady(s)).toBe(true);
  });

  it.each(["pending", "failed", "stale", "skipped", "running", "anything"])(
    "not ready: %s",
    (s) => {
      expect(isExternalGateReady(s)).toBe(false);
    },
  );
});

describe("collapseLatestExternalPerGate", () => {
  it("keeps the max-createdAt representative per gateId (single run)", () => {
    const rows = [
      row("a", "ci", "r1", "2026-06-01T10:00:00.000Z"),
      row("b", "ci", "r1", "2026-06-01T12:00:00.000Z"), // newest for ci
      row("c", "lint", "r1", "2026-06-01T09:00:00.000Z"),
    ];

    const out = collapseLatestExternalPerGate(rows, (r) => r.gateId);

    expect(out.map((r) => r.id).sort()).toEqual(["b", "c"]);
  });

  it("breaks an equal-createdAt tie by id descending", () => {
    const ts = "2026-06-01T12:00:00.000Z";
    const rows = [
      row("id-1", "ci", "r1", ts),
      row("id-3", "ci", "r1", ts), // same ts, larger id wins
      row("id-2", "ci", "r1", ts),
    ];

    const out = collapseLatestExternalPerGate(rows, (r) => r.gateId);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("id-3");
  });

  it("keys per-run when keyOf includes runId (multi-run, no cross-run collision)", () => {
    const rows = [
      row("a", "ci", "r1", "2026-06-01T10:00:00.000Z"),
      row("b", "ci", "r2", "2026-06-01T09:00:00.000Z"),
    ];

    const out = collapseLatestExternalPerGate(
      rows,
      (r) => `${r.runId}:${r.gateId}`,
    );

    // Same gateId across two runs stays distinct — both representatives kept.
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("returns [] for empty input", () => {
    expect(collapseLatestExternalPerGate([], (r: Row) => r.gateId)).toEqual([]);
  });
});
