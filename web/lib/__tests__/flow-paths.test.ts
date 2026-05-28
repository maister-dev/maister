import os from "node:os";

import { describe, expect, it } from "vitest";

import {
  flowIdSchema,
  flowRevisionSchema,
  projectFlowSymlinkPath,
  projectSlugSchema,
  sourceUrlSchema,
  systemCachePath,
  versionTagSchema,
  workspaceRootSchema,
} from "@/lib/flow-paths";
import { MaisterError, isMaisterError } from "@/lib/errors";

// Forty-char lowercase hex git SHA used throughout the tests.
const TEST_SHA = "abc1234567890abcdef1234567890abcdef12345";

describe("systemCachePath", () => {
  it("returns <HOME>/.maister/flows/<id>@<short_sha> for a real git SHA", () => {
    expect(systemCachePath("bugfix", TEST_SHA)).toBe(
      `${os.homedir()}/.maister/flows/bugfix@abc123456789`,
    );
  });

  it("accepts the 'unknown' sentinel used for local-source installs", () => {
    expect(systemCachePath("flow1", "unknown")).toBe(
      `${os.homedir()}/.maister/flows/flow1@unknown`,
    );
  });
});

describe("projectFlowSymlinkPath", () => {
  it("returns <workspaceRoot>/.maister/<slug>/flows/<flowId>", () => {
    expect(projectFlowSymlinkPath("/repos/foo", "foo", "bugfix")).toBe(
      "/repos/foo/.maister/foo/flows/bugfix",
    );
  });
});

describe("flowIdSchema (SINK invariant)", () => {
  it("rejects flowId containing '/'", () => {
    expect(() => systemCachePath("bug/fix", TEST_SHA)).toThrowError(
      MaisterError,
    );
    try {
      systemCachePath("bug/fix", TEST_SHA);
    } catch (err) {
      expect(isMaisterError(err) && err.code).toBe("FLOW_INSTALL");
    }
  });

  it("rejects flowId equal to '..'", () => {
    expect(() => systemCachePath("..", TEST_SHA)).toThrowError(MaisterError);
  });

  it("rejects flowId containing '..' as substring", () => {
    expect(() => systemCachePath("a..b", TEST_SHA)).toThrowError(MaisterError);
  });

  it("rejects flowId equal to '.'", () => {
    expect(() => systemCachePath(".", TEST_SHA)).toThrowError(MaisterError);
  });

  it("rejects empty flowId", () => {
    expect(() => systemCachePath("", TEST_SHA)).toThrowError(MaisterError);
  });

  it("rejects flowId longer than 64 chars", () => {
    const tooLong = "a".repeat(65);

    expect(() => systemCachePath(tooLong, TEST_SHA)).toThrowError(MaisterError);
  });

  it("rejects flowId with whitespace", () => {
    expect(() => systemCachePath("bug fix", TEST_SHA)).toThrowError(
      MaisterError,
    );
  });
});

describe("flowRevisionSchema (SINK invariant on systemCachePath)", () => {
  it("rejects a version tag where a revision is expected", () => {
    // systemCachePath now demands a 40-char hex SHA (or the
    // 'unknown' sentinel) — a semver tag must be rejected at the
    // SINK so a confused caller cannot silently produce a tag-keyed
    // cache directory under the new SHA-keyed regime.
    expect(() => systemCachePath("bugfix", "v1.0.0")).toThrowError(
      MaisterError,
    );
  });

  it("rejects revision containing '/'", () => {
    expect(() => systemCachePath("bugfix", "abc/123")).toThrowError(
      MaisterError,
    );
  });

  it("rejects revision equal to '..'", () => {
    expect(() => systemCachePath("bugfix", "..")).toThrowError(MaisterError);
  });

  it("rejects empty revision", () => {
    expect(() => systemCachePath("bugfix", "")).toThrowError(MaisterError);
  });

  it("rejects revision that is 39-char hex (one short of a real SHA)", () => {
    const tooShort = "a".repeat(39);

    expect(() => systemCachePath("bugfix", tooShort)).toThrowError(
      MaisterError,
    );
  });

  it("rejects uppercase hex (git emits lowercase)", () => {
    const upper = "ABC1234567890ABCDEF1234567890ABCDEF12345";

    expect(() => systemCachePath("bugfix", upper)).toThrowError(MaisterError);
  });

  it("accepts a real 40-char hex SHA and the 'unknown' sentinel", () => {
    expect(flowRevisionSchema.safeParse(TEST_SHA).success).toBe(true);
    expect(flowRevisionSchema.safeParse("unknown").success).toBe(true);
  });
});

describe("versionTagSchema (still exported for install-code use)", () => {
  it("accepts plain semver and arbitrary tag names", () => {
    expect(versionTagSchema.safeParse("v1.0.0").success).toBe(true);
    expect(versionTagSchema.safeParse("main").success).toBe(true);
    expect(versionTagSchema.safeParse("release-2026-05-26").success).toBe(true);
  });
});

describe("projectSlugSchema", () => {
  it("accepts kebab-case slugs", () => {
    expect(projectSlugSchema.safeParse("my-app").success).toBe(true);
    expect(projectSlugSchema.safeParse("foundation-app").success).toBe(true);
    expect(projectSlugSchema.safeParse("a1").success).toBe(true);
  });

  it("rejects PascalCase / snake_case / leading hyphen", () => {
    expect(projectSlugSchema.safeParse("MyApp").success).toBe(false);
    expect(projectSlugSchema.safeParse("my_app").success).toBe(false);
    expect(projectSlugSchema.safeParse("-my-app").success).toBe(false);
    expect(projectSlugSchema.safeParse("my-app-").success).toBe(false);
  });

  it("rejects empty projectSlug via projectFlowSymlinkPath", () => {
    expect(() =>
      projectFlowSymlinkPath("/repos/foo", "", "bugfix"),
    ).toThrowError(MaisterError);
  });
});

describe("workspaceRootSchema", () => {
  it("rejects relative workspaceRoot", () => {
    expect(() =>
      projectFlowSymlinkPath("relative/path", "foo", "bugfix"),
    ).toThrowError(MaisterError);
  });

  it("rejects workspaceRoot containing '..' segment", () => {
    expect(() =>
      projectFlowSymlinkPath("/repos/../etc", "foo", "bugfix"),
    ).toThrowError(MaisterError);
  });

  it("accepts plain absolute paths", () => {
    expect(workspaceRootSchema.safeParse("/repos/foo").success).toBe(true);
    expect(workspaceRootSchema.safeParse("/tmp/test").success).toBe(true);
  });
});

describe("sourceUrlSchema", () => {
  it("accepts HTTPS git URLs", () => {
    expect(
      sourceUrlSchema.safeParse("https://github.com/org/repo.git").success,
    ).toBe(true);
  });

  it("accepts shorthand source identifiers", () => {
    expect(sourceUrlSchema.safeParse("github.com/org/repo").success).toBe(true);
  });

  it("accepts SSH-style URLs", () => {
    expect(
      sourceUrlSchema.safeParse("git@github.com:org/repo.git").success,
    ).toBe(true);
  });

  it("accepts file:// URLs (used by integration test fixtures)", () => {
    expect(
      sourceUrlSchema.safeParse("file:///tmp/fixtures/flow-plugin.git").success,
    ).toBe(true);
  });

  it("rejects whitespace", () => {
    expect(sourceUrlSchema.safeParse("github.com /org/repo").success).toBe(
      false,
    );
  });

  it("rejects shell metacharacters", () => {
    expect(sourceUrlSchema.safeParse("github.com;rm -rf /").success).toBe(
      false,
    );
    expect(sourceUrlSchema.safeParse("github.com&attack").success).toBe(false);
    expect(sourceUrlSchema.safeParse("$(curl evil.sh)").success).toBe(false);
  });

  it("rejects empty source", () => {
    expect(sourceUrlSchema.safeParse("").success).toBe(false);
  });
});

describe("flowIdSchema export (independent of systemCachePath)", () => {
  it("exposes a parsable schema for callers that need a raw zod check", () => {
    expect(flowIdSchema.safeParse("valid").success).toBe(true);
    expect(flowIdSchema.safeParse("../escape").success).toBe(false);
  });
});
