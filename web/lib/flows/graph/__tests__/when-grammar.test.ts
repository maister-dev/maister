import { describe, expect, it } from "vitest";

import { evalWhen, getPath, parseWhen } from "@/lib/flows/graph/when-grammar";

describe("getPath — shared safe nested getter", () => {
  it("resolves a top-level key", () => {
    expect(getPath({ outcome: "bug" }, "outcome")).toBe("bug");
  });

  it("resolves a nested dot-path", () => {
    expect(getPath({ triage: { outcome: "feature" } }, "triage.outcome")).toBe(
      "feature",
    );
    expect(getPath({ a: { b: { c: 3 } } }, "a.b.c")).toBe(3);
  });

  it("returns undefined (never throws) for a missing path", () => {
    expect(getPath({ a: 1 }, "b")).toBeUndefined();
    expect(getPath({ a: { b: 1 } }, "a.c")).toBeUndefined();
    expect(getPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
    expect(getPath(undefined, "a")).toBeUndefined();
    expect(getPath("scalar", "a")).toBeUndefined();
    expect(getPath({}, "")).toBeUndefined();
  });

  it("never resolves an inherited prototype key", () => {
    expect(getPath({}, "toString")).toBeUndefined();
    expect(getPath({}, "constructor")).toBeUndefined();
  });
});

describe("parseWhen — predicate grammar", () => {
  it("parses every operator", () => {
    const ops = [">=", ">", "<=", "<", "==", "!="] as const;

    for (const op of ops) {
      const r = parseWhen(`confidence ${op} 0.8`);

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.predicate).toEqual({ field: "confidence", op, rhs: 0.8 });
      }
    }
  });

  it("tolerates whitespace around the operator and ends", () => {
    const r = parseWhen("   confidence>=0.8   ");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.predicate).toEqual({ field: "confidence", op: ">=", rhs: 0.8 });

    const r2 = parseWhen("score   <    10");

    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.predicate).toEqual({ field: "score", op: "<", rhs: 10 });
  });

  it("parses a nested dot-path field", () => {
    const r = parseWhen("verdict.confidence >= 0.42");

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.predicate.field).toBe("verdict.confidence");
  });

  it("parses integer, float, leading-dot, and negative numbers", () => {
    expect(parseWhen("n == 3")).toMatchObject({ ok: true, predicate: { rhs: 3 } });
    expect(parseWhen("n == 3.5")).toMatchObject({ ok: true, predicate: { rhs: 3.5 } });
    expect(parseWhen("n == .5")).toMatchObject({ ok: true, predicate: { rhs: 0.5 } });
    expect(parseWhen("n >= -1")).toMatchObject({ ok: true, predicate: { rhs: -1 } });
  });

  it("returns a typed error (never throws) for malformed input", () => {
    for (const bad of [
      "",
      "confidence",
      "confidence >=",
      ">= 0.8",
      "confidence ~ 0.8",
      "confidence >= abc",
      "confidence => 0.8",
      "1field >= 2",
      "a.b. >= 1",
      "confidence >= 0.8 and score < 1",
    ]) {
      const r = parseWhen(bad);

      expect(r.ok, `"${bad}" should not parse`).toBe(false);
      if (!r.ok) expect(typeof r.error).toBe("string");
    }
  });
});

describe("evalWhen — predicate evaluation", () => {
  const p = (s: string) => {
    const r = parseWhen(s);

    if (!r.ok) throw new Error(r.error);

    return r.predicate;
  };

  it("evaluates each operator against a numeric lhs", () => {
    expect(evalWhen(p("c >= 0.8"), { c: 0.8 })).toBe(true);
    expect(evalWhen(p("c > 0.8"), { c: 0.8 })).toBe(false);
    expect(evalWhen(p("c <= 0.8"), { c: 0.9 })).toBe(false);
    expect(evalWhen(p("c < 0.8"), { c: 0.5 })).toBe(true);
    expect(evalWhen(p("c == 1"), { c: 1 })).toBe(true);
    expect(evalWhen(p("c != 1"), { c: 1 })).toBe(false);
  });

  it("resolves a nested lhs via getPath", () => {
    expect(evalWhen(p("verdict.confidence >= 0.7"), { verdict: { confidence: 0.9 } })).toBe(true);
  });

  it("a missing or non-numeric lhs is a NO-MATCH (never throws)", () => {
    expect(evalWhen(p("c >= 0.8"), {})).toBe(false);
    expect(evalWhen(p("c >= 0.8"), { c: "high" })).toBe(false);
    expect(evalWhen(p("c >= 0.8"), { c: null })).toBe(false);
    expect(evalWhen(p("a.b >= 1"), { a: 1 })).toBe(false);
    expect(evalWhen(p("c >= 0.8"), null)).toBe(false);
  });
});
