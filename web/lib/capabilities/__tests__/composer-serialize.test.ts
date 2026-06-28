import { describe, expect, it } from "vitest";

import {
  type ComposerSegment,
  canonicalToSegments,
  chipToCanonical,
  paragraphsToCanonical,
  promoteComposerSkillTokens,
  segmentsToCanonical,
  segmentsToParagraphs,
} from "@/lib/capabilities/composer-serialize";
import { flowYamlV1Schema } from "@/lib/config.schema";

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

  it("segmentsToParagraphs splits text on newlines into per-line groups", () => {
    expect(
      segmentsToParagraphs(canonicalToSegments("line one\nline two")),
    ).toEqual([
      [{ type: "text", text: "line one" }],
      [{ type: "text", text: "line two" }],
    ]);
  });

  it("keeps a chip inline within its paragraph and splits around it", () => {
    expect(
      segmentsToParagraphs(canonicalToSegments("run @skill:x\nthen done")),
    ).toEqual([
      [
        { type: "text", text: "run " },
        { type: "chip", kind: "skill", slug: "x" },
      ],
      [{ type: "text", text: "then done" }],
    ]);
  });

  it("round-trips a MULTILINE prompt with chips (regression: newlines were dropped)", () => {
    const value = "first line @skill:plan\nsecond line\nthird @agent:reviewer";

    expect(
      paragraphsToCanonical(segmentsToParagraphs(canonicalToSegments(value))),
    ).toBe(value);
  });

  it("preserves blank lines (empty paragraphs) in the round-trip", () => {
    const value = "a\n\nb";

    expect(
      paragraphsToCanonical(segmentsToParagraphs(canonicalToSegments(value))),
    ).toBe(value);
  });

  it("round-trips template variables as plain text, not chips", () => {
    expect(
      canonicalToSegments("Use {{ steps.plan.vars.verdict ?? '' }}"),
    ).toEqual([
      { type: "text", text: "Use {{ steps.plan.vars.verdict ?? '' }}" },
    ]);
  });

  it("promotes raw slash and dollar skills at the composer commit boundary", () => {
    expect(
      promoteComposerSkillTokens("run /aif-plan then $review and @reviewer", [
        { kind: "skill", slug: "aif-plan" },
        { kind: "skill", slug: "review" },
        { kind: "subagent", slug: "reviewer" },
      ]),
    ).toBe("run @skill:aif-plan then @skill:review and @reviewer");
  });

  it("leaves paths, shell vars, missing skills, commands, and canonical tokens intact", () => {
    expect(
      promoteComposerSkillTokens(
        "@skill:aif-plan /usr/bin $HOME /missing /schedule",
        [
          { kind: "skill", slug: "aif-plan" },
          { kind: "command", slug: "schedule" },
        ],
      ),
    ).toBe("@skill:aif-plan /usr/bin $HOME /missing /schedule");
  });

  it("keeps promoted skills and template variables valid inside flow prompts", () => {
    const prompt = promoteComposerSkillTokens(
      "/aif-plan with {{ steps.plan.vars.verdict ?? '' }}",
      [{ kind: "skill", slug: "aif-plan" }],
    );

    expect(() =>
      flowYamlV1Schema.parse({
        schemaVersion: 1,
        name: "Prompt",
        nodes: [
          { id: "plan", type: "ai_coding", action: { prompt } },
          { id: "review", type: "human" },
        ],
      }),
    ).not.toThrow();
  });
});
