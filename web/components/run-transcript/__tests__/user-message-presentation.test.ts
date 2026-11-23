import { describe, expect, it } from "vitest";

import {
  readDisclosureKeys,
  writeDisclosure,
} from "../use-user-message-expansion";
import {
  isLongUserText,
  repeatedUserIds,
  splitUserText,
} from "../user-message-presentation";

const explanation =
  "When the task or agent instructions require a packaged skill, read its SKILL.md using the workspace-relative path below. Use this copy for the packaged instructions and resolve its companion files relative to SKILL.md.";
const skills = `## Packaged skills\n${explanation}\n${Array.from({ length: 21 }, (_, i) => `- skill-${i}: \`path/skill-${i}/SKILL.md\``).join("\n")}\n`;
const long = "x".repeat(2001);
const row = (id: string, content = long, preview = false) => ({
  id,
  role: "user" as const,
  content,
  ...(preview
    ? { preview: { originalBytes: 9000, fullContentHref: "/full" } }
    : {}),
});

describe("USER presentation", () => {
  it("uses strict character and logical-line boundaries", () => {
    for (const size of [1999, 2000, 2001])
      expect(isLongUserText("x".repeat(size))).toBe(size > 2000);
    for (const newline of ["\n", "\r\n"]) {
      expect(isLongUserText(Array(12).fill("").join(newline))).toBe(false);
      expect(isLongUserText(Array(13).fill("").join(newline))).toBe(true);
    }
  });
  it("compares complete long prompts exactly and resets at clear", () => {
    const rows = [
      row("a"),
      { id: "assistant", role: "assistant" as const, content: long },
      row("answer", "yes"),
      row("b"),
      row("space", long + " "),
      row("preview", long, true),
      row("clear", "/clear"),
      row("c"),
      row("d"),
    ];

    expect([...repeatedUserIds(rows)]).toEqual(["b", "d"]);
    expect([...repeatedUserIds(rows.slice(3, 4))]).toEqual([]);
    expect([
      ...repeatedUserIds([row("a", "short"), row("b", "short")]),
    ]).toEqual([]);
    expect([
      ...repeatedUserIds([row("a", long + "\n"), row("b", long + "\r\n")]),
    ]).toEqual([]);
  });
  it("segments generated lists losslessly in any position and newline style", () => {
    for (const source of [
      skills + long,
      long + "\n" + skills,
      long + "\n" + skills + "tail",
      skills + "\n" + skills,
    ]) {
      for (const text of [source, source.replaceAll("\n", "\r\n")]) {
        const parts = splitUserText(text);

        expect(parts.map((part) => part.text).join("")).toBe(text);
        expect(
          parts
            .filter((part) => part.kind === "skills")
            .map((part) => part.count),
        ).toEqual(source === skills + "\n" + skills ? [21, 21] : [21]);
      }
    }
  });
  it("leaves fenced, empty, mixed and malformed sections ordinary text", () => {
    for (const text of [
      "```\n" + skills + "```",
      "~~~md\n" + skills + "~~~",
      skills.replace(explanation, "unknown"),
      skills.replace("- skill-1:", "- malformed"),
      skills + "- invalid\n",
      `## Packaged skills\n${explanation}\n`,
    ]) {
      expect(splitUserText(text)).toEqual([
        { kind: "text", text, start: 0, end: text.length },
      ]);
    }
  });
});

it("normalizes only valid disclosure tuples without losing unrelated state", () => {
  const url = new URL(
    "https://example.test/run?tab=trace&transcript-open=bad#message",
  );

  url.searchParams.append(
    "transcript-open",
    JSON.stringify([1, "a", "message"]),
  );
  url.searchParams.append(
    "transcript-open",
    JSON.stringify([1, "a", "message"]),
  );
  url.searchParams.append(
    "transcript-open",
    JSON.stringify([2, "a", "message"]),
  );
  expect([...readDisclosureKeys(url.search)]).toEqual([
    JSON.stringify([1, "a", "message"]),
  ]);
  const next = writeDisclosure(url.href, "b", "skills:0", true);

  expect(next.searchParams.get("tab")).toBe("trace");
  expect(next.hash).toBe("#message");
  expect(next.searchParams.getAll("transcript-open")).toHaveLength(2);
  expect(
    writeDisclosure(next.href, "a", "message", false).searchParams.getAll(
      "transcript-open",
    ),
  ).toEqual([JSON.stringify([1, "b", "skills:0"])]);
});
