import { describe, expect, it } from "vitest";

import { parseTaskSourceInput } from "../validate";

const valid = {
  kind: "github",
  instance: "github.com",
  scope: "acme/widgets",
  externalId: "I_kwDOUPjedM8AAAABU8w1nQ",
  externalKey: "#7",
  url: "https://github.com/acme/widgets/issues/7",
};

function refused(patch: Record<string, unknown>): boolean {
  return !parseTaskSourceInput({ ...valid, ...patch }).ok;
}

describe("parseTaskSourceInput", () => {
  it("normalizes the instance to lower case and keeps optional fields nullable", () => {
    const parsed = parseTaskSourceInput({
      kind: "jira",
      instance: "Jira.Example.COM",
      scope: "PROJ",
      externalId: "10042",
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "jira",
        instance: "jira.example.com",
        scope: "PROJ",
        externalId: "10042",
        externalKey: null,
        url: null,
      },
    });
  });

  it.each([
    ["kind at 32 chars", false, { kind: `a${"b".repeat(31)}` }],
    ["kind at 33 chars", true, { kind: `a${"b".repeat(32)}` }],
    ["kind with upper case", true, { kind: "GitHub" }],
    ["kind starting with a digit", true, { kind: "1hub" }],
    ["instance at 253 chars", false, { instance: "a".repeat(253) }],
    ["instance at 254 chars", true, { instance: "a".repeat(254) }],
    ["instance with scheme", true, { instance: "https://github.com" }],
    ["instance with userinfo", true, { instance: "user@github.com" }],
    ["instance with port", true, { instance: "github.com:443" }],
    ["instance with path", true, { instance: "github.com/acme" }],
    ["instance with query", true, { instance: "github.com?x=1" }],
    ["scope at 256 chars", false, { scope: "s".repeat(256) }],
    ["scope at 257 chars", true, { scope: "s".repeat(257) }],
    ["empty scope", true, { scope: "" }],
    ["externalId at 256 chars", false, { externalId: "i".repeat(256) }],
    ["externalId at 257 chars", true, { externalId: "i".repeat(257) }],
    ["externalKey at 64 chars", false, { externalKey: "k".repeat(64) }],
    ["externalKey at 65 chars", true, { externalKey: "k".repeat(65) }],
    ["url at 2048 chars", false, { url: `https://h.io/${"p".repeat(2035)}` }],
    ["url at 2049 chars", true, { url: `https://h.io/${"p".repeat(2036)}` }],
    ["http url", true, { url: "http://github.com/acme/widgets/issues/7" }],
    ["url with userinfo", true, { url: "https://u:p@github.com/x" }],
    ["unknown field", true, { extra: 1 }],
  ])("%s → refused=%s", (_name, expected, patch) => {
    expect(refused(patch)).toBe(expected);
  });
});
