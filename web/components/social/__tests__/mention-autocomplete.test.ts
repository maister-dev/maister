// ADR-151 — the composer's mention popover is driven by three pure helpers so
// the component holds interaction only. Detection mirrors the server-side
// token rule (word boundary, `@`, handle charset) — the two must agree or the
// popover offers a completion the write path will not resolve.

import { describe, expect, it } from "vitest";

import {
  applyMentionSelection,
  detectMentionQuery,
  filterMentionCandidates,
  type MentionCandidateView,
} from "@/components/social/mention-autocomplete";

const CANDIDATES: MentionCandidateView[] = [
  { id: "core:triager", name: "Triager" },
  { id: "core:reviewer", name: "Code Reviewer" },
  { id: "aif:planner", name: "Planner" },
];

describe("detectMentionQuery", () => {
  it("opens at the start of the field", () => {
    expect(detectMentionQuery("@tri", 4)).toEqual({ start: 0, query: "tri" });
  });

  it("opens after whitespace and after an opening paren", () => {
    expect(detectMentionQuery("hey @tri", 8)).toEqual({
      start: 4,
      query: "tri",
    });
    expect(detectMentionQuery("(@tri", 5)).toEqual({ start: 1, query: "tri" });
  });

  it("opens on a bare @ with an empty query", () => {
    expect(detectMentionQuery("hey @", 5)).toEqual({ start: 4, query: "" });
  });

  it("does not open mid-word — an email is not a mention", () => {
    expect(detectMentionQuery("user@example", 12)).toBeNull();
  });

  it("closes once whitespace follows the token", () => {
    expect(detectMentionQuery("@tri done", 9)).toBeNull();
  });

  it("reads the token under the caret, not the end of the text", () => {
    // Caret sits right after "@tri"; the trailing text is a different token.
    expect(detectMentionQuery("@tri and @rev", 4)).toEqual({
      start: 0,
      query: "tri",
    });
  });

  it("accepts the canonical package-qualified form", () => {
    expect(detectMentionQuery("@core:tri", 9)).toEqual({
      start: 0,
      query: "core:tri",
    });
  });

  it("returns null with no @ at all", () => {
    expect(detectMentionQuery("plain text", 10)).toBeNull();
  });
});

describe("filterMentionCandidates", () => {
  it("returns every candidate for an empty query", () => {
    expect(filterMentionCandidates(CANDIDATES, "").map((c) => c.id)).toEqual([
      "core:triager",
      "core:reviewer",
      "aif:planner",
    ]);
  });

  it("matches id and name, case-insensitively", () => {
    expect(
      filterMentionCandidates(CANDIDATES, "PLAN").map((c) => c.id),
    ).toEqual(["aif:planner"]);
    expect(
      filterMentionCandidates(CANDIDATES, "reviewer").map((c) => c.id),
    ).toEqual(["core:reviewer"]);
  });

  it("ranks prefix matches before substring matches", () => {
    const ranked = filterMentionCandidates(
      [
        // Neither the id, the stem, nor the name starts with "code".
        { id: "core:helper-code", name: "Helper" },
        { id: "aif:code", name: "Code" },
      ],
      "code",
    );

    expect(ranked.map((c) => c.id)).toEqual(["aif:code", "core:helper-code"]);
  });

  it("caps the list at 8 rows", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `core:agent-${i}`,
      name: `Agent ${i}`,
    }));

    expect(filterMentionCandidates(many, "agent")).toHaveLength(8);
  });

  it("returns nothing when no candidate matches", () => {
    expect(filterMentionCandidates(CANDIDATES, "zzz")).toEqual([]);
  });
});

describe("applyMentionSelection", () => {
  it("replaces the partial token and leaves one trailing space", () => {
    expect(applyMentionSelection("hey @tri", 8, 4, "core:triager")).toEqual({
      text: "hey @core:triager ",
      caret: 18,
    });
  });

  it("keeps the text after the caret intact", () => {
    expect(
      applyMentionSelection("@tri please look", 4, 0, "core:triager"),
    ).toEqual({
      text: "@core:triager  please look",
      caret: 14,
    });
  });

  it("works on a bare @ with no typed query", () => {
    expect(applyMentionSelection("@", 1, 0, "aif:planner")).toEqual({
      text: "@aif:planner ",
      caret: 13,
    });
  });
});
