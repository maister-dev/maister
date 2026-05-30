import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hostToolStatus,
  probeTool,
  reposRoot,
  worktreesRoot,
} from "@/lib/instance-config";

const ENV_KEYS = [
  "MAISTER_REPOS_ROOT",
  "MAISTER_WORKTREES_ROOT",
  "MAISTER_WORKTREE_ROOT",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe("reposRoot", () => {
  it("returns MAISTER_REPOS_ROOT when set", () => {
    process.env.MAISTER_REPOS_ROOT = "/custom/repos";

    expect(reposRoot()).toBe("/custom/repos");
  });

  it("falls back to <home>/.maister/repos when unset", () => {
    const expected = path.join(os.homedir(), ".maister", "repos");

    expect(reposRoot()).toBe(expected);
    expect(reposRoot()).not.toContain("~");
  });
});

describe("worktreesRoot", () => {
  it("returns MAISTER_WORKTREES_ROOT when set", () => {
    process.env.MAISTER_WORKTREES_ROOT = "/custom/worktrees";

    expect(worktreesRoot()).toBe("/custom/worktrees");
  });

  it("falls back to deprecated MAISTER_WORKTREE_ROOT when MAISTER_WORKTREES_ROOT unset", () => {
    process.env.MAISTER_WORKTREE_ROOT = "/legacy/worktrees";

    expect(worktreesRoot()).toBe("/legacy/worktrees");
  });

  it("falls back to <home>/.maister/worktrees when both unset", () => {
    const expected = path.join(os.homedir(), ".maister", "worktrees");

    expect(worktreesRoot()).toBe(expected);
    expect(worktreesRoot()).not.toContain("~");
  });
});

describe("hostToolStatus", () => {
  it("reports git as available with a version string", async () => {
    const tools = await hostToolStatus();

    expect(Array.isArray(tools)).toBe(true);

    const git = tools.find((t) => t.name === "git");

    expect(git).toBeDefined();
    expect(git?.available).toBe(true);
    expect(typeof git?.version).toBe("string");
    expect(git?.version).not.toBeNull();
  });

  it("degrades a missing tool to unavailable without throwing", async () => {
    const probe = await probeTool("maister-nonexistent-binary-xyz");

    expect(probe).toEqual({
      name: "maister-nonexistent-binary-xyz",
      available: false,
      version: null,
    });
  });
});
