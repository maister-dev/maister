import { describe, expect, it } from "vitest";

import {
  type ComposerSegment,
  canonicalToSegments,
  chipToCanonical,
  segmentsToCanonical,
} from "@/lib/capabilities/composer-serialize";

describe("composer-serialize (FR-D / FR-E1)", () => {
  it("chipToCanonical maps kind→prefix", () => {
    expect(chipToCanonical("skill", "aif-plan")).toBe("@skill:aif-plan");
    expect(chipToCanonical("subagent", "reviewer")).toBe("@agent:reviewer");
  });

  it("segmentsToCanonical joins text + chips into the storage string", () => {
    const segments: ComposerSegment[] = [
      { type: "text", text: "run " },
      { type: "chip", kind: "skill", slug: "aif-plan" },
      { type: "text", text: " then ask " },
      { type: "chip", kind: "subagent", slug: "reviewer" },
    ];

    expect(segmentsToCanonical(segments)).toBe(
      "run @skill:aif-plan then ask @agent:reviewer",
    );
  });

  it("canonicalToSegments splits canonical tokens into chips, rest verbatim", () => {
    expect(
      canonicalToSegments("run @skill:aif-plan then @agent:reviewer ok"),
    ).toEqual([
      { type: "text", text: "run " },
      { type: "chip", kind: "skill", slug: "aif-plan" },
      { type: "text", text: " then " },
      { type: "chip", kind: "subagent", slug: "reviewer" },
      { type: "text", text: " ok" },
    ]);
  });

  it("leaves raw /slug and paths verbatim (not chipified here)", () => {
    expect(canonicalToSegments("use /aif-plan in /usr/bin")).toEqual([
      { type: "text", text: "use /aif-plan in /usr/bin" },
    ]);
  });

  it("round-trips canonical string → segments → canonical string", () => {
    const value = "a @skill:x b @agent:y c";

    expect(segmentsToCanonical(canonicalToSegments(value))).toBe(value);
  });

  it("handles a chip at the very start", () => {
    expect(canonicalToSegments("@skill:plan now")).toEqual([
      { type: "chip", kind: "skill", slug: "plan" },
      { type: "text", text: " now" },
    ]);
  });

  it("empty string → no segments", () => {
    expect(canonicalToSegments("")).toEqual([]);
    expect(segmentsToCanonical([])).toBe("");
  });
});
