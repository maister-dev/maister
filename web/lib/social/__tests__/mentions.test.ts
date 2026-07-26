import { describe, expect, it } from "vitest";

import {
  collectAgentMentionCandidates,
  collectMentionCandidates,
  expandResolvedMentions,
  resolveAgentMentions,
  segmentMarkdown,
  type MentionableAgent,
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

// ADR-151 — agent handles ride the SAME segmentation pass as KEY-N, so
// code/link inertness is inherited rather than re-implemented.
const AGENTS: MentionableAgent[] = [
  { id: "core:triager", stem: "triager", name: "Triager", summonable: true },
  {
    id: "core:reviewer",
    stem: "reviewer",
    name: "Reviewer",
    summonable: false,
  },
  { id: "aif:reviewer", stem: "reviewer", name: "AIF Reviewer", summonable: true },
];

describe("collectAgentMentionCandidates", () => {
  it("collects canonical and bare handles from text segments only", () => {
    const body = "@core:triager and @triager but not `@core:hidden` or [x](@y)";

    expect(collectAgentMentionCandidates(segmentMarkdown(body))).toEqual([
      "core:triager",
      "triager",
    ]);
  });

  it("requires a word boundary — an email address is not a mention", () => {
    expect(
      collectAgentMentionCandidates(segmentMarkdown("user@example.com writes")),
    ).toEqual([]);
  });

  it("opens on start-of-segment, whitespace, and an opening paren", () => {
    expect(collectAgentMentionCandidates(segmentMarkdown("@a x @b (@c)"))).toEqual(
      ["a", "b", "c"],
    );
  });

  it("ends the handle at the last alphanumeric", () => {
    expect(
      collectAgentMentionCandidates(
        segmentMarkdown("@triager. @core:triager, @triager- done"),
      ),
    ).toEqual(["triager", "core:triager"]);
  });

  it("dedupes repeated handles and ignores fenced blocks", () => {
    const body = "@triager twice @triager\n```\n@core:hidden\n```\n";

    expect(collectAgentMentionCandidates(segmentMarkdown(body))).toEqual([
      "triager",
    ]);
  });

  it("yields nothing for a bare @ or a punctuation-only handle", () => {
    expect(collectAgentMentionCandidates(segmentMarkdown("@ @.. @-"))).toEqual(
      [],
    );
  });
});

describe("resolveAgentMentions", () => {
  it("resolves a canonical id exactly", () => {
    const resolved = resolveAgentMentions(["core:triager"], AGENTS);

    expect(resolved.get("core:triager")).toEqual({
      id: "core:triager",
      name: "Triager",
      summonable: true,
    });
  });

  it("resolves a bare stem only when it is unique in the project", () => {
    const resolved = resolveAgentMentions(["triager", "reviewer"], AGENTS);

    expect(resolved.get("triager")?.id).toBe("core:triager");
    // `reviewer` exists in two packages — ambiguous, so it stays literal.
    expect(resolved.has("reviewer")).toBe(false);
  });

  it("carries write-time summonability, including false", () => {
    expect(resolveAgentMentions(["core:reviewer"], AGENTS).get("core:reviewer"))
      .toEqual({
        id: "core:reviewer",
        name: "Reviewer",
        summonable: false,
      });
  });

  it("leaves an unknown handle unresolved", () => {
    expect(resolveAgentMentions(["core:ghost", "ghost"], AGENTS).size).toBe(0);
  });

  it("resolves nothing when the project has no candidates", () => {
    expect(resolveAgentMentions(["triager"], []).size).toBe(0);
  });
});

describe("expandResolvedMentions with agent mentions", () => {
  const tasks = new Map([
    ["MAI-1", { slug: "maister", key: "MAI", number: 1 }],
  ]);
  const agents = resolveAgentMentions(
    ["core:triager", "triager", "core:reviewer"],
    AGENTS,
  );

  it("expands a canonical handle to a rooted /agents link", () => {
    const out = expandResolvedMentions(
      segmentMarkdown("@core:triager please look"),
      tasks,
      agents,
    );

    expect(out).toBe("[@core:triager](/agents/core:triager) please look");
  });

  // The leading slash is load-bearing: without it react-markdown's
  // urlTransform parses `core:` as a URL scheme and drops the link.
  it("always roots the href at /", () => {
    const out = expandResolvedMentions(
      segmentMarkdown("@triager"),
      new Map(),
      agents,
    );

    expect(out.startsWith("[@core:triager](/agents/")).toBe(true);
    expect(out).not.toContain("](core:");
  });

  it("expands a bare handle to its canonical id", () => {
    expect(
      expandResolvedMentions(segmentMarkdown("ping @triager"), new Map(), agents),
    ).toBe("ping [@core:triager](/agents/core:triager)");
  });

  it("keeps trailing punctuation outside the link", () => {
    expect(
      expandResolvedMentions(
        segmentMarkdown("ping @triager, then wait"),
        new Map(),
        agents,
      ),
    ).toBe("ping [@core:triager](/agents/core:triager), then wait");
  });

  it("expands every occurrence of the same handle", () => {
    expect(
      expandResolvedMentions(
        segmentMarkdown("@triager and @triager"),
        new Map(),
        agents,
      ),
    ).toBe(
      "[@core:triager](/agents/core:triager) and [@core:triager](/agents/core:triager)",
    );
  });

  it("expands a non-summonable mention too — the chip is historical record", () => {
    expect(
      expandResolvedMentions(
        segmentMarkdown("@core:reviewer fyi"),
        new Map(),
        agents,
      ),
    ).toBe("[@core:reviewer](/agents/core:reviewer) fyi");
  });

  it("leaves unresolved handles literal", () => {
    expect(
      expandResolvedMentions(
        segmentMarkdown("@ghost and @reviewer"),
        new Map(),
        agents,
      ),
    ).toBe("@ghost and @reviewer");
  });

  it("never rewrites inside code, fences, or existing links", () => {
    const body =
      "@triager `@triager` [@triager](http://x) text\n```\n@triager\n```\nend @triager";

    expect(expandResolvedMentions(segmentMarkdown(body), new Map(), agents)).toBe(
      "[@core:triager](/agents/core:triager) `@triager` [@triager](http://x) text\n```\n@triager\n```\nend [@core:triager](/agents/core:triager)",
    );
  });

  // One pass, two token families: a stem that itself looks like KEY-N must not
  // be rewritten by the task-mention branch inside the agent handle.
  it("mixes KEY-N and @agent in one body without cross-rewriting", () => {
    const mixed = resolveAgentMentions(["core:MAI-1"], [
      { id: "core:MAI-1", stem: "MAI-1", name: "Odd", summonable: true },
    ]);
    const out = expandResolvedMentions(
      segmentMarkdown("fix MAI-1 with @core:MAI-1"),
      tasks,
      mixed,
    );

    expect(out).toBe(
      "fix [MAI-1](/projects/maister/tasks/1) with [@core:MAI-1](/agents/core:MAI-1)",
    );
  });
});

// One token regex, one walk: a KEY-N-shaped stem inside a handle is part of
// the handle, so it must not become a task-mention candidate (which would
// otherwise write a task_mentioned activity + inbox fanout for a task the
// author never referenced).
describe("collectMentionCandidates vs agent handles", () => {
  it("does not collect a KEY-N-shaped stem inside an agent handle", () => {
    expect(
      collectMentionCandidates(segmentMarkdown("ping @core:MAI-1 now")),
    ).toEqual([]);
    expect(
      collectMentionCandidates(segmentMarkdown("fix MAI-2 via @core:MAI-1")),
    ).toEqual([{ key: "MAI", number: 2 }]);
  });
});
