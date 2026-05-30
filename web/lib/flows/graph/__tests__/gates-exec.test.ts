import { describe, expect, it } from "vitest";

import { isPassVerdict, parseVerdict } from "@/lib/flows/graph/gates-exec";

describe("parseVerdict", () => {
  it("extracts a structured verdict embedded in agent prose", () => {
    const out =
      'Here is my review.\n{"verdict":"fail","confidence":0.9,"reasons":["missing tests"],"recommendedAction":"rework"}\nDone.';
    const v = parseVerdict(out);

    expect(v).toEqual({
      verdict: "fail",
      confidence: 0.9,
      reasons: ["missing tests"],
      recommendedAction: "rework",
    });
  });

  it("returns null when no verdict JSON is present (caller records a failed gate)", () => {
    expect(parseVerdict("just prose, no json verdict here")).toBeNull();
    expect(parseVerdict('{"notVerdict": true}')).toBeNull();
  });

  it("picks the last valid verdict block", () => {
    const out = '{"verdict":"pass"} then later {"verdict":"fail"}';

    expect(parseVerdict(out)?.verdict).toBe("fail");
  });

  it("coerces non-string reasons and tolerates missing optional fields", () => {
    const v = parseVerdict('{"verdict":"pass","reasons":[1,2]}');

    expect(v?.verdict).toBe("pass");
    expect(v?.reasons).toEqual(["1", "2"]);
    expect(v?.confidence).toBeUndefined();
  });

  it("extracts a verdict object that contains a nested object (brace-balanced)", () => {
    const out =
      'verdict: {"verdict":"pass","meta":{"x":1,"y":{"z":2}},"confidence":0.5}';
    const v = parseVerdict(out);

    expect(v?.verdict).toBe("pass");
    expect(v?.confidence).toBe(0.5);
  });

  it("ignores braces inside string literals", () => {
    const v = parseVerdict(
      '{"verdict":"fail","reasons":["use { and } carefully"]}',
    );

    expect(v?.verdict).toBe("fail");
    expect(v?.reasons).toEqual(["use { and } carefully"]);
  });
});

describe("isPassVerdict", () => {
  it("treats pass-like verdicts (case/space-insensitive) as passing", () => {
    for (const v of [
      "pass",
      "PASS",
      " Passed ",
      "approve",
      "approved",
      "ok",
      "success",
    ]) {
      expect(isPassVerdict(v)).toBe(true);
    }
  });

  it("treats everything else as failing", () => {
    for (const v of ["fail", "reject", "rework", "unparseable", "blocked"]) {
      expect(isPassVerdict(v)).toBe(false);
    }
  });
});
