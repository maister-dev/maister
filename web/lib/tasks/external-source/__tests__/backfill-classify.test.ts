import { describe, expect, it } from "vitest";

import {
  classifyLegacyGithubSources,
  type LegacySourceCandidate,
} from "../legacy-markers";

const ID_8 = "I_kwDOUPjedM8AAAABU8w1nQ";
const ID_20 = "I_kwDOUPjedM8AAAABYDsXwA";

function markers(id: string | null, url: string | null): string {
  return [
    "Do the thing.",
    id === null ? "" : `Source-GitHub-ID: ${id}`,
    url === null ? "" : `Source-GitHub-Issue: ${url}`,
  ].join("\n");
}

function task(
  key: string,
  texts: string[],
  extra: Partial<LegacySourceCandidate> = {},
): LegacySourceCandidate {
  return {
    taskId: `id-${key}`,
    taskKey: key,
    projectId: "p1",
    title: `[GitHub #7] ${key}`,
    texts,
    bound: null,
    ...extra,
  };
}

function classOf(candidates: LegacySourceCandidate[]): Record<string, string> {
  return Object.fromEntries(
    classifyLegacyGithubSources(candidates).map((r) => [
      r.taskKey,
      r.classification,
    ]),
  );
}

describe("classifyLegacyGithubSources", () => {
  it("binds an exact marker pair to the node id, canonical URL and lower-cased scope", () => {
    const [result] = classifyLegacyGithubSources([
      task("MAI-8", [
        markers(ID_8, "https://GitHub.com/Maister-Dev/MAIster/issues/7"),
      ]),
    ]);

    expect(result).toEqual({
      taskId: "id-MAI-8",
      taskKey: "MAI-8",
      classification: "bindable",
      source: {
        kind: "github",
        instance: "github.com",
        scope: "maister-dev/maister",
        externalId: ID_8,
        externalKey: "#7",
        url: "https://github.com/maister-dev/maister/issues/7",
      },
    });
  });

  it("finds markers that survive only in an older statement revision", () => {
    expect(
      classOf([
        task("MAI-20", [
          "current prompt without markers",
          markers(ID_20, "https://github.com/a/b/issues/7"),
        ]),
      ]),
    ).toEqual({ "MAI-20": "bindable" });
  });

  it.each([
    ["no markers at all", ["plain prompt"], {}, "no_markers"],
    ["ID without URL", [markers(ID_8, null)], {}, "incomplete"],
    [
      "URL without ID",
      [markers(null, "https://github.com/a/b/issues/7")],
      {},
      "incomplete",
    ],
    [
      "numeric-only ID",
      [markers("123456", "https://github.com/a/b/issues/7")],
      {},
      "malformed",
    ],
    [
      "URL that is not an issue",
      [markers(ID_8, "https://github.com/a/b/pull/7")],
      {},
      "malformed",
    ],
    [
      "title number differs from URL number",
      [markers(ID_8, "https://github.com/a/b/issues/9")],
      {},
      "conflicting",
    ],
    [
      "two identities across prompt and history",
      [
        markers(ID_8, "https://github.com/a/b/issues/7"),
        markers(ID_20, "https://github.com/a/b/issues/7"),
      ],
      {},
      "conflicting",
    ],
    [
      "already bound to the same identity",
      [markers(ID_8, "https://github.com/a/b/issues/7")],
      { bound: { kind: "github", instance: "github.com", externalId: ID_8 } },
      "already_bound_same",
    ],
    [
      "already bound to another identity",
      [markers(ID_8, "https://github.com/a/b/issues/7")],
      { bound: { kind: "github", instance: "github.com", externalId: ID_20 } },
      "conflicting",
    ],
  ])("%s → %s", (_name, texts, extra, expected) => {
    expect(
      classOf([
        task("T-1", texts as string[], extra as Partial<LegacySourceCandidate>),
      ]),
    ).toEqual({
      "T-1": expected,
    });
  });

  it("marks every task of a project that shares one identity as duplicate, but not across projects", () => {
    const text = markers(ID_8, "https://github.com/a/b/issues/7");

    expect(
      classOf([
        task("A-1", [text]),
        task("A-2", [text]),
        task("B-1", [text], { projectId: "p2" }),
      ]),
    ).toEqual({ "A-1": "duplicate", "A-2": "duplicate", "B-1": "bindable" });
  });

  it("treats an identity already bound to another task of the project as duplicate", () => {
    const text = markers(ID_8, "https://github.com/a/b/issues/7");

    expect(
      classOf([
        task("A-1", [text], {
          bound: { kind: "github", instance: "github.com", externalId: ID_8 },
        }),
        task("A-2", [text]),
      ]),
    ).toEqual({ "A-1": "already_bound_same", "A-2": "duplicate" });
  });
});
