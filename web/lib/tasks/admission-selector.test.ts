import { describe, expect, it } from "vitest";

import {
  CLASS_RANK,
  type AdmissionCandidate,
  orderAdmissions,
  projectShareAllowsC2,
  reserveAllowsC2,
} from "./admission-selector";

function cand(
  cls: AdmissionCandidate["cls"],
  priority: AdmissionCandidate["priority"],
  fifoMs: number,
  id = `${cls}-${priority}-${fifoMs}`,
): AdmissionCandidate {
  return { cls, priority, fifoMs, ref: { runId: id } };
}

describe("ADR-121 admission ordering (D-A: strict criticality)", () => {
  it("orders by criticality weight DESC as the PRIMARY key", () => {
    const out = orderAdmissions([
      cand("C3", "low", 1),
      cand("C1", "urgent", 100),
      cand("C2", "high", 50),
    ]);

    expect(out.map((c) => c.priority)).toEqual(["urgent", "high", "low"]);
  });

  it("at EQUAL weight, breaks ties resume-first (C3 < C1 < C2)", () => {
    const out = orderAdmissions([
      cand("C2", "normal", 10),
      cand("C1", "normal", 10),
      cand("C3", "normal", 10),
    ]);

    expect(out.map((c) => c.cls)).toEqual(["C3", "C1", "C2"]);
    expect(CLASS_RANK.C3).toBeLessThan(CLASS_RANK.C1);
    expect(CLASS_RANK.C1).toBeLessThan(CLASS_RANK.C2);
  });

  it("a high-criticality fresh task preempts a lower-criticality resume (D-A)", () => {
    const out = orderAdmissions([
      cand("C3", "low", 1), // a just-answered low-priority resume
      cand("C2", "urgent", 999), // a fresh urgent blocker
    ]);

    expect(out[0].priority).toBe("urgent");
    expect(out[0].cls).toBe("C2");
  });

  it("final tiebreak is FIFO ASC at equal weight AND class", () => {
    const out = orderAdmissions([
      cand("C1", "normal", 30),
      cand("C1", "normal", 10),
      cand("C1", "normal", 20),
    ]);

    expect(out.map((c) => c.fifoMs)).toEqual([10, 20, 30]);
  });

  it("a run with no task (null priority) sorts at the normal weight", () => {
    const out = orderAdmissions([
      cand("C1", null, 1),
      cand("C1", "high", 1),
      cand("C1", "low", 1),
    ]);

    expect(out.map((c) => c.priority)).toEqual(["high", null, "low"]);
  });
});

describe("ADR-121 C2 capacity guards", () => {
  it("reserveAllowsC2: auto-drain stops at flowCap − reserve (INV-8)", () => {
    // cap 6, reserve 2 → auto allowed only while liveFlow < 4.
    expect(reserveAllowsC2(3, 6, 2)).toBe(true);
    expect(reserveAllowsC2(4, 6, 2)).toBe(false);
    expect(reserveAllowsC2(5, 6, 2)).toBe(false);
    // reserve 0 → allowed up to the full cap.
    expect(reserveAllowsC2(5, 6, 0)).toBe(true);
  });

  it("projectShareAllowsC2: bounded by maxInFlightAuto, Infinity = unbounded (INV-9)", () => {
    expect(projectShareAllowsC2(1, 2)).toBe(true);
    expect(projectShareAllowsC2(2, 2)).toBe(false);
    expect(projectShareAllowsC2(999, Number.POSITIVE_INFINITY)).toBe(true);
  });
});
