// ADR-108 (M40) T4.3 — the shipped native claude PreToolUse path-guard script.
// Unit-tests the pure decision logic (the runnable `main` reads stdin + argv and
// is exercised end-to-end by the P4 defense-in-depth integration test).

import { describe, expect, it } from "vitest";

import {
  evaluatePathGuard,
  extractToolPath,
  globToRegExp,
  toWorktreeRelative,
} from "../../../scripts/native-path-guard.mjs";

const CWD = "/repos/app/.maister/wt";

describe("native-path-guard — globToRegExp", () => {
  it("`*` stays within a segment; `**` crosses separators", () => {
    expect(globToRegExp("src/*.ts").test("src/x.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/x.ts")).toBe(false);
    expect(globToRegExp("src/**").test("src/sub/x.ts")).toBe(true);
    expect(globToRegExp("src/**").test("lib/x.ts")).toBe(false);
  });
});

describe("native-path-guard — toWorktreeRelative", () => {
  it("returns a POSIX relative path for in-tree, null for escapes", () => {
    expect(toWorktreeRelative(CWD, "src/x.ts")).toBe("src/x.ts");
    expect(toWorktreeRelative(CWD, `${CWD}/src/x.ts`)).toBe("src/x.ts");
    expect(toWorktreeRelative(CWD, "../../etc/passwd")).toBeNull();
    expect(toWorktreeRelative(CWD, "/etc/passwd")).toBeNull();
    expect(toWorktreeRelative(CWD, ".")).toBeNull();
  });
});

describe("native-path-guard — extractToolPath", () => {
  it("reads file_path / notebook_path; undefined when absent", () => {
    expect(extractToolPath({ file_path: "src/x.ts" })).toBe("src/x.ts");
    expect(extractToolPath({ notebook_path: "nb.ipynb" })).toBe("nb.ipynb");
    expect(extractToolPath({ other: 1 })).toBeUndefined();
    expect(extractToolPath(null)).toBeUndefined();
  });
});

describe("native-path-guard — evaluatePathGuard", () => {
  it("allows an in-lane write", () => {
    expect(
      evaluatePathGuard({
        toolInput: { file_path: "src/x.ts" },
        allowedPaths: ["src/**", "tests/**"],
        cwd: CWD,
      }),
    ).toEqual({ deny: false });
  });

  it("denies an out-of-lane write", () => {
    const d = evaluatePathGuard({
      toolInput: { file_path: "lib/secret.ts" },
      allowedPaths: ["src/**"],
      cwd: CWD,
    });

    expect(d.deny).toBe(true);
    expect(d.reason).toContain("allowed lane");
  });

  it("denies an out-of-tree write regardless of the allow-set", () => {
    const d = evaluatePathGuard({
      toolInput: { file_path: "/etc/passwd" },
      allowedPaths: ["**"],
      cwd: CWD,
    });

    expect(d.deny).toBe(true);
    expect(d.reason).toContain("outside the worktree");
  });

  it("the `**` sentinel allows any in-tree write", () => {
    expect(
      evaluatePathGuard({
        toolInput: { file_path: "anywhere/deep/x.ts" },
        allowedPaths: ["**"],
        cwd: CWD,
      }),
    ).toEqual({ deny: false });
  });

  it("denies a write with no extractable path (kind-only fallback)", () => {
    const d = evaluatePathGuard({
      toolInput: { command: "rm -rf /" },
      allowedPaths: ["src/**"],
      cwd: CWD,
    });

    expect(d.deny).toBe(true);
    expect(d.reason).toContain("kind-only fallback");
  });
});
