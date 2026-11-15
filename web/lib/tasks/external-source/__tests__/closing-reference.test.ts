import { describe, expect, it } from "vitest";

import {
  githubClosingReference,
  projectGithubHost,
} from "../closing-reference";

const github = {
  kind: "github",
  instance: "github.com",
  scope: "acme/widgets",
  externalId: "I_7",
  externalKey: "#7",
  url: null,
};

describe("githubClosingReference (C8)", () => {
  it.each([
    ["an eligible same-host GitHub binding", {}, "Closes acme/widgets#7"],
    [
      "a cross-repo scope on the same host",
      { source: { ...github, scope: "acme/other" } },
      "Closes acme/other#7",
    ],
    ["partial resolution", { resolvesTask: false }, null],
    ["no binding", { source: null }, null],
    ["a non-GitHub kind", { source: { ...github, kind: "jira" } }, null],
    [
      "another GitHub host",
      { source: { ...github, instance: "ghe.example.com" } },
      null,
    ],
    ["a project not hosted on GitHub", { projectGithubHost: null }, null],
    [
      "a non-numeric key",
      { source: { ...github, externalKey: "PROJ-7" } },
      null,
    ],
    [
      "no key (never derived from the id or the internal number)",
      { source: { ...github, externalKey: null } },
      null,
    ],
  ])("%s", (_name, over, expected) => {
    expect(
      githubClosingReference({
        source: github,
        projectGithubHost: "github.com",
        resolvesTask: true,
        ...over,
      }),
    ).toBe(expected);
  });
});

describe("projectGithubHost", () => {
  it.each([
    [
      { provider: "github", repoUrl: "https://GitHub.com/acme/app.git" },
      "github.com",
    ],
    [
      { provider: "github", repoUrl: "git@github.com:acme/app.git" },
      "github.com",
    ],
    [{ provider: "gitlab", repoUrl: "https://gitlab.com/acme/app.git" }, null],
    [{ provider: "github", repoUrl: null }, null],
  ])("%j → %s", (project, expected) => {
    expect(projectGithubHost(project)).toBe(expected);
  });
});
