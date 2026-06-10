import type {
  ComposeReplyComment,
  ComposeRootComment,
  ComposeThread,
} from "@/lib/review-comments/serialize";

import { describe, expect, it } from "vitest";

import {
  compareThreadReplies,
  compareThreadRoots,
} from "@/lib/review-comments/order";
import { composeReworkPayload } from "@/lib/review-comments/serialize";

const T0 = new Date("2026-06-10T10:00:00Z");
const T1 = new Date("2026-06-10T10:01:00Z");
const T2 = new Date("2026-06-10T10:02:00Z");
const T3 = new Date("2026-06-10T10:03:00Z");

function makeThread(
  root: Partial<ComposeRootComment> = {},
  replies: ComposeReplyComment[] = [],
): ComposeThread {
  return {
    root: {
      id: "root-1",
      filePath: "a.ts",
      side: "new",
      line: 1,
      lineContent: "line one",
      authorLabel: "Alice",
      body: "Fix it.",
      createdAt: T0,
      ...root,
    },
    replies,
  };
}

function makeReply(
  over: Partial<ComposeReplyComment> = {},
): ComposeReplyComment {
  return {
    id: "reply-1",
    authorLabel: "Bob",
    body: "Agreed.",
    createdAt: T1,
    ...over,
  };
}

// Frozen minimal threads section used by the joiner tests below.
const MIN_SECTION =
  "## Review comments\n\n### a.ts:1 (new)\n\n> line one\n\n**Alice:**\n\nFix it.";

describe("composeReworkPayload — zero open threads ⇒ byte-identity to the raw summary (D3)", () => {
  it.each([
    ["empty string", ""],
    ["plain text", "Looks good overall, minor nits."],
    [
      "multiline markdown",
      "# Summary\n\n- item one\n- item two\n\n```ts\nconst a = 1;\n```",
    ],
    ["text with trailing newline", "Fix the build.\n"],
    ["whitespace-only", "   \n\t\n  "],
  ])("passes the %s summary through untouched", (_name, summary) => {
    expect(composeReworkPayload(summary, [])).toBe(summary);
  });
});

describe("composeReworkPayload — frozen template", () => {
  function fullExample() {
    const replyBob = makeReply({
      id: "p-bob",
      authorLabel: "Bob",
      body: "Agreed.",
      createdAt: T1,
    });
    const replyAlice = makeReply({
      id: "p-alice",
      authorLabel: "Alice",
      body: "Fixed in next pass.",
      createdAt: T2,
    });
    const appTen = (replies: ComposeReplyComment[]): ComposeThread =>
      makeThread(
        {
          id: "r-app-10",
          filePath: "src/app.ts",
          side: "new",
          line: 10,
          lineContent: "const total = items.length;",
          authorLabel: "Reviewer One",
          body: "Off-by-one here.",
          createdAt: T0,
        },
        replies,
      );
    const appTwo = makeThread({
      id: "r-app-2",
      filePath: "src/app.ts",
      side: "old",
      line: 2,
      lineContent: "let legacy = true;",
      authorLabel: "Reviewer One",
      body: "Why was this removed?",
      createdAt: T1,
    });
    const readme = makeThread({
      id: "r-readme-5",
      filePath: "README.md",
      side: "new",
      line: 5,
      lineContent: "## Setup",
      authorLabel: "Reviewer Two",
      body: "Mention pnpm version.",
      createdAt: T3,
    });

    return { replyBob, replyAlice, appTen, appTwo, readme };
  }

  const FULL_SUMMARY = "Address all anchored comments below.";
  const FULL_EXPECTED = [
    "Address all anchored comments below.",
    "",
    "## Review comments",
    "",
    "### README.md:5 (new)",
    "",
    "> ## Setup",
    "",
    "**Reviewer Two:**",
    "",
    "Mention pnpm version.",
    "",
    "### src/app.ts:2 (old)",
    "",
    "> let legacy = true;",
    "",
    "**Reviewer One:**",
    "",
    "Why was this removed?",
    "",
    "### src/app.ts:10 (new)",
    "",
    "> const total = items.length;",
    "",
    "**Reviewer One:**",
    "",
    "Off-by-one here.",
    "",
    "**Reply — Bob:**",
    "",
    "Agreed.",
    "",
    "**Reply — Alice:**",
    "",
    "Fixed in next pass.",
  ].join("\n");

  it("composes summary + ordered threads + replies into the exact frozen markdown", () => {
    const { replyBob, replyAlice, appTen, appTwo, readme } = fullExample();

    const out = composeReworkPayload(FULL_SUMMARY, [
      appTen([replyBob, replyAlice]),
      readme,
      appTwo,
    ]);

    expect(out).toBe(FULL_EXPECTED);
  });

  it("is deterministic: shuffled thread and reply input yields the same bytes", () => {
    const { replyBob, replyAlice, appTen, appTwo, readme } = fullExample();

    const out = composeReworkPayload(FULL_SUMMARY, [
      readme,
      appTwo,
      appTen([replyAlice, replyBob]),
    ]);

    expect(out).toBe(FULL_EXPECTED);
  });

  it("never appends a trailing newline", () => {
    const { replyBob, replyAlice, appTen, appTwo, readme } = fullExample();

    const out = composeReworkPayload(FULL_SUMMARY, [
      appTen([replyBob, replyAlice]),
      readme,
      appTwo,
    ]);

    expect(out.endsWith("\n")).toBe(false);
  });

  it("does not mutate the input thread or reply arrays", () => {
    const { replyBob, replyAlice, appTen, appTwo, readme } = fullExample();
    const replies = [replyAlice, replyBob];
    const threads = [readme, appTen(replies), appTwo];

    composeReworkPayload(FULL_SUMMARY, threads);

    expect(threads[0]).toBe(readme);
    expect(threads[2]).toBe(appTwo);
    expect(replies[0]).toBe(replyAlice);
    expect(replies[1]).toBe(replyBob);
  });
});

describe("composeReworkPayload — summary joiner rules", () => {
  it("joins a non-empty summary and the threads section with exactly \\n\\n", () => {
    expect(composeReworkPayload("Summary.", [makeThread()])).toBe(
      `Summary.\n\n${MIN_SECTION}`,
    );
  });

  it("emits the threads section alone when the summary is the empty string", () => {
    expect(composeReworkPayload("", [makeThread()])).toBe(MIN_SECTION);
  });

  it("treats a whitespace-only summary as a summary part (only the empty string collapses)", () => {
    expect(composeReworkPayload("  ", [makeThread()])).toBe(
      `  \n\n${MIN_SECTION}`,
    );
  });

  it("keeps summary bytes untouched: a trailing-newline summary joins literally", () => {
    expect(composeReworkPayload("Summary.\n", [makeThread()])).toBe(
      `Summary.\n\n\n${MIN_SECTION}`,
    );
  });
});

describe("composeReworkPayload — thread ordering", () => {
  it("orders lines numerically, not lexicographically (2 < 10)", () => {
    const lineTen = makeThread({ id: "r-10", line: 10, body: "Line ten." });
    const lineTwo = makeThread({ id: "r-2", line: 2, body: "Line two." });

    const out = composeReworkPayload("", [lineTen, lineTwo]);

    expect(out.indexOf("Line two.")).toBeLessThan(out.indexOf("Line ten."));
  });

  it("breaks same file+line ties with side old before new", () => {
    const newSide = makeThread({
      id: "r-new",
      side: "new",
      line: 7,
      body: "New side note.",
    });
    const oldSide = makeThread({
      id: "r-old",
      side: "old",
      line: 7,
      body: "Old side note.",
    });

    const out = composeReworkPayload("", [newSide, oldSide]);

    expect(out.indexOf("### a.ts:7 (old)")).toBeLessThan(
      out.indexOf("### a.ts:7 (new)"),
    );
  });

  it("breaks identical anchors by created_at before id", () => {
    const early = makeThread({
      id: "r-z",
      createdAt: T0,
      body: "Earlier comment.",
    });
    const late = makeThread({
      id: "r-a",
      createdAt: T1,
      body: "Later comment.",
    });

    const out = composeReworkPayload("", [late, early]);

    expect(out.indexOf("Earlier comment.")).toBeLessThan(
      out.indexOf("Later comment."),
    );
  });

  it("breaks identical anchors and created_at by id", () => {
    const idA = makeThread({ id: "r-a", createdAt: T0, body: "Id a body." });
    const idB = makeThread({ id: "r-b", createdAt: T0, body: "Id b body." });

    const out = composeReworkPayload("", [idB, idA]);

    expect(out.indexOf("Id a body.")).toBeLessThan(out.indexOf("Id b body."));
  });

  it("orders replies by created_at then id", () => {
    const byTime = composeReworkPayload("", [
      makeThread({}, [
        makeReply({ id: "p-z", createdAt: T2, body: "Second reply." }),
        makeReply({ id: "p-a", createdAt: T1, body: "First reply." }),
      ]),
    ]);

    expect(byTime.indexOf("First reply.")).toBeLessThan(
      byTime.indexOf("Second reply."),
    );

    const byId = composeReworkPayload("", [
      makeThread({}, [
        makeReply({ id: "p-b", createdAt: T1, body: "Reply b." }),
        makeReply({ id: "p-a", createdAt: T1, body: "Reply a." }),
      ]),
    ]);

    expect(byId.indexOf("Reply a.")).toBeLessThan(byId.indexOf("Reply b."));
  });
});

describe("composeReworkPayload — block rendering", () => {
  it("renders a reply after its root in the **Reply — <author>:** form", () => {
    const out = composeReworkPayload("", [
      makeThread({}, [makeReply({ id: "p-1", createdAt: T1 })]),
    ]);

    expect(out).toBe(`${MIN_SECTION}\n\n**Reply — Bob:**\n\nAgreed.`);
  });

  it("renders multiple threads on the same file", () => {
    const out = composeReworkPayload("", [
      makeThread({ id: "r-5", line: 5, lineContent: "five", body: "On five." }),
      makeThread({
        id: "r-3",
        line: 3,
        lineContent: "three",
        body: "On three.",
      }),
    ]);

    expect(out).toBe(
      "## Review comments\n\n### a.ts:3 (new)\n\n> three\n\n**Alice:**\n\nOn three.\n\n### a.ts:5 (new)\n\n> five\n\n**Alice:**\n\nOn five.",
    );
  });

  it("preserves a multiline body verbatim", () => {
    const body =
      "First paragraph.\n\nSecond paragraph with `code`.\n- list item";

    const out = composeReworkPayload("", [makeThread({ body })]);

    expect(out).toBe(
      `## Review comments\n\n### a.ts:1 (new)\n\n> line one\n\n**Alice:**\n\n${body}`,
    );
  });

  it("quotes every line of a multiline line_content with '> '", () => {
    const out = composeReworkPayload("", [
      makeThread({ lineContent: "if (a) {\n  return b;\n}" }),
    ]);

    expect(out).toBe(
      "## Review comments\n\n### a.ts:1 (new)\n\n> if (a) {\n>   return b;\n> }\n\n**Alice:**\n\nFix it.",
    );
  });

  it("quotes an empty-string line_content as a bare '> ' line", () => {
    const out = composeReworkPayload("", [
      makeThread({ line: 3, lineContent: "" }),
    ]);

    expect(out).toBe(
      "## Review comments\n\n### a.ts:3 (new)\n\n> \n\n**Alice:**\n\nFix it.",
    );
  });
});

describe("order comparators — frozen (file_path, line, side old<new, created_at, id)", () => {
  function rootKey(over: {
    filePath?: string;
    line?: number;
    side?: "old" | "new";
    createdAt?: Date;
    id?: string;
  }): {
    filePath: string | null;
    line: number | null;
    side: "old" | "new" | null;
    createdAt: Date;
    id: string;
  } {
    return {
      filePath: over.filePath ?? "a.ts",
      line: over.line ?? 1,
      side: over.side ?? "new",
      createdAt: over.createdAt ?? T0,
      id: over.id ?? "id-1",
    };
  }

  it("compareThreadRoots applies file_path, numeric line, side, created_at, id in that order", () => {
    expect(
      compareThreadRoots(
        rootKey({ filePath: "a.ts", line: 100 }),
        rootKey({ filePath: "b.ts", line: 1 }),
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(rootKey({ line: 2 }), rootKey({ line: 10 })),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(
        rootKey({ line: 1, side: "new" }),
        rootKey({ line: 2, side: "old" }),
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(rootKey({ side: "old" }), rootKey({ side: "new" })),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(
        rootKey({ createdAt: T0, id: "z" }),
        rootKey({ createdAt: T1, id: "a" }),
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(rootKey({ id: "id-a" }), rootKey({ id: "id-b" })),
    ).toBeLessThan(0);
    expect(compareThreadRoots(rootKey({}), rootKey({}))).toBe(0);
  });

  it("compareThreadReplies applies created_at then id", () => {
    expect(
      compareThreadReplies(
        { createdAt: T0, id: "z" },
        { createdAt: T1, id: "a" },
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadReplies(
        { createdAt: T0, id: "a" },
        { createdAt: T0, id: "b" },
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadReplies(
        { createdAt: T0, id: "b" },
        { createdAt: T0, id: "a" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareThreadReplies(
        { createdAt: T0, id: "a" },
        { createdAt: T0, id: "a" },
      ),
    ).toBe(0);
  });
});
