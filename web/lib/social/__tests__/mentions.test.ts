import { describe, expect, it } from "vitest";

import {
  collectMentionCandidates,
  expandResolvedMentions,
  segmentMarkdown,
} from "@/lib/social/mentions";

function textOf(segments: ReturnType<typeof segmentMarkdown>): string {
  return segments
    .filter((s) => s.kind === "text")
    .map((s) => s.value)
    .join("");
}

describe("segmentMarkdown", () => {
  it("returns one text segment for plain prose", () => {
    const segments = segmentMarkdown("plain prose with MAI-12 inside");

    expect(segments).toEqual([
      { kind: "text", value: "plain prose with MAI-12 inside" },
    ]);
  });

  it("re-joins to the exact original body", () => {
    const body =
      "before `code MAI-1` mid [MAI-2 label](http://x/MAI-3) after\n```\nfence MAI-4\n```\ntail";
    const segments = segmentMarkdown(body);

    expect(segments.map((s) => s.value).join("")).toBe(body);
  });

  it("carves out backtick fenced blocks", () => {
    const body = "a MAI-1\n```ts\ncode MAI-2\n```\nb MAI-3";
    const segments = segmentMarkdown(body);

    expect(textOf(segments)).toContain("MAI-1");
    expect(textOf(segments)).toContain("MAI-3");
    expect(textOf(segments)).not.toContain("MAI-2");
  });

  it("carves out tilde fenced blocks", () => {
    const body = "a\n~~~\ncode MAI-2\n~~~\nb MAI-3";
    const segments = segmentMarkdown(body);

    expect(textOf(segments)).not.toContain("MAI-2");
    expect(textOf(segments)).toContain("MAI-3");
  });

  it("keeps an unclosed fence as a skip zone to the end", () => {
    const body = "a MAI-1\n```\ncode MAI-2";
    const segments = segmentMarkdown(body);

    expect(textOf(segments)).toContain("MAI-1");
    expect(textOf(segments)).not.toContain("MAI-2");
  });

  it("carves out inline code spans including double-backtick spans", () => {
    const body = "x `MAI-1` y ``nested ` tick MAI-2`` z MAI-3";
    const segments = segmentMarkdown(body);

    expect(textOf(segments)).not.toContain("MAI-1");
    expect(textOf(segments)).not.toContain("MAI-2");
    expect(textOf(segments)).toContain("MAI-3");
  });

  it("carves out markdown links — both label and target", () => {
    const body = "see [MAI-1 docs](https://x.test/MAI-2) and MAI-3";
    const segments = segmentMarkdown(body);

    expect(textOf(segments)).not.toContain("MAI-1");
    expect(textOf(segments)).not.toContain("MAI-2");
    expect(textOf(segments)).toContain("MAI-3");
  });

  it("treats an unmatched bracket as plain text", () => {
    const body = "array[0] and MAI-7";
    const segments = segmentMarkdown(body);

    expect(textOf(segments)).toContain("MAI-7");
    expect(textOf(segments)).toContain("array[0]");
  });
});

describe("collectMentionCandidates", () => {
  it("collects KEY-N tokens from text segments only", () => {
    const body = "MAI-1 then `MAI-2` then [x](u/MAI-3) then ZZZ9-44";
    const candidates = collectMentionCandidates(segmentMarkdown(body));

    expect(candidates).toEqual([
      { key: "MAI", number: 1 },
      { key: "ZZZ9", number: 44 },
    ]);
  });

  it("does NOT match lowercase keys", () => {
    expect(collectMentionCandidates(segmentMarkdown("mai-12 Mai-12"))).toEqual(
      [],
    );
  });

  it("matches tokens at string edges", () => {
    expect(collectMentionCandidates(segmentMarkdown("MAI-1"))).toEqual([
      { key: "MAI", number: 1 },
    ]);
    expect(collectMentionCandidates(segmentMarkdown("end with MAI-2"))).toEqual(
      [{ key: "MAI", number: 2 }],
    );
  });

  it("extends a leading word char into the key; a trailing one kills the match", () => {
    // "XMAI-1" is itself a well-formed token (key XMAI) — it resolves only
    // if such a project exists. "MAI-1x" has no boundary after the digits.
    expect(
      collectMentionCandidates(segmentMarkdown("XMAI-1 MAI-1x MAI-2")),
    ).toEqual([
      { key: "XMAI", number: 1 },
      { key: "MAI", number: 2 },
    ]);
  });

  it("dedupes repeated mentions of the same task", () => {
    expect(
      collectMentionCandidates(segmentMarkdown("MAI-1 and MAI-1 again")),
    ).toEqual([{ key: "MAI", number: 1 }]);
  });
});

describe("expandResolvedMentions", () => {
  const resolved = new Map([
    ["MAI-1", { slug: "maister", key: "MAI", number: 1 }],
    ["OPS-2", { slug: "ops-tools", key: "OPS", number: 2 }],
  ]);

  it("replaces resolved tokens with markdown task links in text segments", () => {
    const out = expandResolvedMentions(
      segmentMarkdown("fix MAI-1 before OPS-2"),
      resolved,
    );

    expect(out).toBe(
      "fix [MAI-1](/projects/maister/tasks/1) before [OPS-2](/projects/ops-tools/tasks/2)",
    );
  });

  it("leaves unresolved tokens literal", () => {
    const out = expandResolvedMentions(
      segmentMarkdown("fix MAI-1 and UNKNOWN-9"),
      resolved,
    );

    expect(out).toBe("fix [MAI-1](/projects/maister/tasks/1) and UNKNOWN-9");
  });

  it("never rewrites inside code, fences, or existing links", () => {
    const body =
      "MAI-1 `MAI-1` [MAI-1](http://x) text\n```\nMAI-1\n```\nend MAI-1";
    const out = expandResolvedMentions(segmentMarkdown(body), resolved);

    expect(out).toBe(
      "[MAI-1](/projects/maister/tasks/1) `MAI-1` [MAI-1](http://x) text\n```\nMAI-1\n```\nend [MAI-1](/projects/maister/tasks/1)",
    );
  });

  it("replaces every occurrence of a resolved token", () => {
    const out = expandResolvedMentions(
      segmentMarkdown("MAI-1 twice MAI-1"),
      resolved,
    );

    expect(out).toBe(
      "[MAI-1](/projects/maister/tasks/1) twice [MAI-1](/projects/maister/tasks/1)",
    );
  });
});
