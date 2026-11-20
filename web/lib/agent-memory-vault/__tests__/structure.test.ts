import { expect, it } from "vitest";

import { parseMemoryStructure } from "../structure";

it("AV-09 parses note, heading and entity references without treating fenced examples as prose", () => {
  const parsed = parseMemoryStructure(
    [
      "---",
      "tags: [Ops, ops, безопасность]",
      "aliases: [Run guide]",
      "---",
      "# Service restart",
      "[[notes/setup#Install]] [[task:CB-42]] [[run:run-7]]",
      "[[brain:item/record-1]] [[knowledge:record-1@3]] [[repo:src/main.ts#L21]]",
      "```text",
      "# Example heading",
      "[[not-a-reference]]",
      "```",
    ].join("\n"),
  );

  expect(parsed.tags).toEqual(["ops", "безопасность"]);
  expect(parsed.aliases).toEqual(["Run guide"]);
  expect(parsed.headings).toEqual(["service restart"]);
  expect(
    parsed.links.map(({ kind, target, fragment }) => ({
      kind,
      target,
      fragment,
    })),
  ).toEqual([
    { kind: "note", target: "notes/setup", fragment: "install" },
    { kind: "task", target: "CB-42", fragment: null },
    { kind: "run", target: "run-7", fragment: null },
    { kind: "brain", target: "record-1", fragment: null },
    { kind: "knowledge", target: "record-1", fragment: "3" },
    { kind: "repo", target: "src/main.ts", fragment: "21" },
  ]);
});

it.each([
  ["alias/anchor", "tags: &refs [qa]\naliases: *refs"],
  ["duplicate reserved key", "tags: [qa]\ntags: [ops]"],
  ["custom scalar tag", "tags: [!custom qa]"],
  ["non-list value", "aliases: qa"],
  ["non-string value", "aliases: [2]"],
  ["intrinsic cap", 'aliases: ["' + "x".repeat(10240) + '"]'],
])("AV-09 refuses %s frontmatter before indexing", (_, yaml) => {
  expect(() => parseMemoryStructure(`---\n${yaml}\n---\nbody`)).toThrow(
    expect.objectContaining({ code: "CONFIG" }),
  );
});
