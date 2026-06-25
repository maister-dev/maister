import { describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import {
  buildCompareUrl,
  preselectPublishSourceId,
  publishLocalPackage,
  webUrlFromGitUrl,
} from "@/lib/local-packages/publish";

describe("webUrlFromGitUrl", () => {
  it("normalizes https + trailing .git / slash", () => {
    expect(webUrlFromGitUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
    expect(webUrlFromGitUrl("https://github.com/org/repo/")).toBe(
      "https://github.com/org/repo",
    );
  });

  it("normalizes ssh + scp-like forms to https", () => {
    expect(webUrlFromGitUrl("git@github.com:org/repo.git")).toBe(
      "https://github.com/org/repo",
    );
    expect(webUrlFromGitUrl("ssh://git@gitlab.com/org/repo.git")).toBe(
      "https://gitlab.com/org/repo",
    );
  });

  it("returns null for an unrecognizable string", () => {
    expect(webUrlFromGitUrl("not a url")).toBeNull();
  });
});

describe("buildCompareUrl", () => {
  it("github / gitea / gitverse use /compare/base...head", () => {
    expect(
      buildCompareUrl(
        "https://github.com/o/r.git",
        "github",
        "main",
        "maister/x",
      ),
    ).toBe("https://github.com/o/r/compare/main...maister/x");
    expect(
      buildCompareUrl(
        "https://gitea.example/o/r",
        "gitea",
        "main",
        "maister/x",
      ),
    ).toBe("https://gitea.example/o/r/compare/main...maister/x");
    expect(
      buildCompareUrl(
        "https://gitverse.ru/o/r",
        "gitverse",
        "main",
        "maister/x",
      ),
    ).toBe("https://gitverse.ru/o/r/compare/main...maister/x");
  });

  it("gitlab uses the new-merge-request url", () => {
    expect(
      buildCompareUrl(
        "https://gitlab.com/o/r.git",
        "gitlab",
        "main",
        "maister/x",
      ),
    ).toBe(
      "https://gitlab.com/o/r/-/merge_requests/new?merge_request%5Bsource_branch%5D=maister%2Fx",
    );
  });

  it("generic falls back to the bare web url; null for an unrecognizable url", () => {
    expect(
      buildCompareUrl("https://example.test/o/r", "generic", "main", "h"),
    ).toBe("https://example.test/o/r");
    expect(buildCompareUrl("not a url", "github", "main", "h")).toBeNull();
  });
});

describe("preselectPublishSourceId", () => {
  const sources = [
    { id: "s1", url: "https://github.com/org/a.git" },
    { id: "s2", url: "git@github.com:org/b.git" },
  ];

  it("matches the package's fork origin across url spellings", () => {
    expect(preselectPublishSourceId("https://github.com/org/a", sources)).toBe(
      "s1",
    );
    expect(
      preselectPublishSourceId("https://github.com/org/b.git", sources),
    ).toBe("s2");
  });

  it("returns null when no source matches or the origin is absent", () => {
    expect(
      preselectPublishSourceId("https://github.com/org/c", sources),
    ).toBeNull();
    expect(preselectPublishSourceId(null, sources)).toBeNull();
  });
});

describe("publishLocalPackage — branch validation", () => {
  it("rejects an invalid branch name with PRECONDITION before any db/git work", async () => {
    await expect(
      publishLocalPackage("pkg", {
        targetSourceId: "s",
        branchName: "bad branch with spaces",
        db: {} as never,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "PRECONDITION",
    );
  });
});
