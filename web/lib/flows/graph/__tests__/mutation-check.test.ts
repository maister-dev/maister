// TC.2 (M29/ADR-073): pure path-set engine + git diff-range helpers + the
// write-if-absent node-start head capture. Pure matrices run without git; the
// git-backed cases build a real tmp repo (mirrors the existing
// immutable-git-payload worktree-test pattern).

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  EMPTY_TREE,
  GIT_UNAVAILABLE_REASON,
  captureNodeStartHead,
  evaluateMutationAssertions,
  readNodeStartHead,
  resolveDiffRange,
  touchedPaths,
} from "@/lib/flows/graph/mutation-check";

const execFileAsync = promisify(execFile);

const RANGE = { base: "base-sha", head: "head-sha" };

function evaluate(
  overrides: Partial<Parameters<typeof evaluateMutationAssertions>[0]> = {},
) {
  return evaluateMutationAssertions({
    nodeTouched: [],
    cumulativeTouched: [],
    basis: "node",
    nodeRange: RANGE,
    cumulativeRange: RANGE,
    evaluated: true,
    ...overrides,
  });
}

describe("evaluateMutationAssertions — must_touch matrices (pure, no git)", () => {
  it("passes when at least one touched path matches a glob", () => {
    const { pass, report } = evaluate({
      nodeTouched: ["src/a.ts", "docs/readme.md"],
      mustTouch: ["src/**"],
    });

    expect(pass).toBe(true);
    expect(report.mustTouch).toEqual({
      globs: ["src/**"],
      matched: ["src/a.ts"],
      matchedTruncated: false,
    });
    expect(report.violations).toEqual([]);
  });

  it("fails when NO touched path matches any glob", () => {
    const { pass, report } = evaluate({
      nodeTouched: ["docs/readme.md"],
      mustTouch: ["src/**", "web/lib/**"],
    });

    expect(pass).toBe(false);
    expect(report.mustTouch.matched).toEqual([]);
    expect(report.violations).toEqual([
      "must_touch: no path matched [src/**, web/lib/**]",
    ]);
  });

  it("fails on an empty diff", () => {
    const { pass } = evaluate({ nodeTouched: [], mustTouch: ["src/**"] });

    expect(pass).toBe(false);
  });

  it("matches dotfiles (picomatch dot: true)", () => {
    const { pass, report } = evaluate({
      nodeTouched: ["src/.env.local", ".github/workflows/ci.yml"],
      mustTouch: [".github/**"],
    });

    expect(pass).toBe(true);
    expect(report.mustTouch.matched).toEqual([".github/workflows/ci.yml"]);

    const dotInDir = evaluate({
      nodeTouched: ["src/.env.local"],
      mustTouch: ["src/**"],
    });

    expect(dotInDir.pass).toBe(true);
  });

  it("matches nested directories with **", () => {
    const { pass } = evaluate({
      nodeTouched: ["web/lib/flows/graph/mutation-check.ts"],
      mustTouch: ["web/lib/**"],
    });

    expect(pass).toBe(true);
  });

  it("passes when a later glob of several matches", () => {
    const { pass } = evaluate({
      nodeTouched: ["supervisor/src/index.ts"],
      mustTouch: ["web/**", "supervisor/**"],
    });

    expect(pass).toBe(true);
  });
});

describe("evaluateMutationAssertions — must_not_touch restrictions (pure)", () => {
  it("fails when the cumulative diff touches a restriction path", () => {
    const { pass, report } = evaluate({
      cumulativeTouched: ["web/lib/db/migrations/0001.sql", "src/a.ts"],
      mustNotTouch: "restrictions",
      restrictionSets: [
        { id: "no-migrations", paths: ["web/lib/db/migrations/**"] },
      ],
    });

    expect(pass).toBe(false);
    expect(report.restrictions.checked).toEqual([
      {
        id: "no-migrations",
        paths: ["web/lib/db/migrations/**"],
        violations: ["web/lib/db/migrations/0001.sql"],
      },
    ]);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain("must_not_touch: 1 violation(s)");
    expect(report.violations[0]).toContain("web/lib/db/migrations/0001.sql");
  });

  it("passes when no restriction path is touched", () => {
    const { pass, report } = evaluate({
      cumulativeTouched: ["src/a.ts"],
      mustNotTouch: "restrictions",
      restrictionSets: [{ id: "no-mig", paths: ["web/lib/db/migrations/**"] }],
    });

    expect(pass).toBe(true);
    expect(report.restrictions.checked[0].violations).toEqual([]);
  });

  it("reports restrictions without paths as unmatchable — never failed on", () => {
    const { pass, report } = evaluate({
      cumulativeTouched: ["anything/at/all.ts"],
      mustNotTouch: "restrictions",
      restrictionSets: [
        { id: "free-text-only" },
        { id: "empty-paths", paths: [] },
      ],
    });

    expect(pass).toBe(true);
    expect(report.restrictions.unmatchable).toEqual([
      "free-text-only",
      "empty-paths",
    ]);
    expect(report.restrictions.checked).toEqual([]);
  });

  it("no resolved restrictions at all → vacuous pass", () => {
    const { pass, report } = evaluate({
      cumulativeTouched: ["src/a.ts"],
      mustNotTouch: "restrictions",
      restrictionSets: [],
    });

    expect(pass).toBe(true);
    expect(report.restrictions).toEqual({ checked: [], unmatchable: [] });
  });

  it("combined: must_touch passes but a restriction violation still fails", () => {
    const { pass, report } = evaluate({
      nodeTouched: ["src/a.ts"],
      cumulativeTouched: ["src/a.ts", "secrets/key.pem"],
      mustTouch: ["src/**"],
      mustNotTouch: "restrictions",
      restrictionSets: [{ id: "no-secrets", paths: ["secrets/**"] }],
    });

    expect(pass).toBe(false);
    expect(report.mustTouch.matched).toEqual(["src/a.ts"]);
    expect(report.violations).toHaveLength(1);
  });
});

describe("evaluateMutationAssertions — report shape (D-C4)", () => {
  it("truncates touched at 500 entries and sets the truncated flag", () => {
    const many = Array.from({ length: 600 }, (_, i) => `src/f${i}.ts`);
    const { report } = evaluate({ nodeTouched: many, mustTouch: ["src/**"] });

    expect(report.touched).toHaveLength(500);
    expect(report.truncated).toBe(true);

    const few = evaluate({
      nodeTouched: ["src/a.ts"],
      mustTouch: ["src/**"],
    });

    expect(few.report.truncated).toBe(false);
  });

  it("caps mustTouch.matched at 500 with its own flag while passing on the full set", () => {
    const many = Array.from({ length: 600 }, (_, i) => `src/f${i}.ts`);
    const { pass, report } = evaluate({
      nodeTouched: many,
      mustTouch: ["src/**"],
    });

    expect(pass).toBe(true);
    expect(report.mustTouch.matched).toHaveLength(500);
    expect(report.mustTouch.matchedTruncated).toBe(true);
  });

  it("records the cumulative-fallback basis with the fallback range", () => {
    const { report } = evaluate({
      nodeTouched: ["src/a.ts"],
      mustTouch: ["src/**"],
      basis: "cumulative-fallback",
      nodeRange: { base: "cumulative-base", head: "tip" },
      cumulativeRange: { base: "cumulative-base", head: "tip" },
    });

    expect(report.basis).toBe("cumulative-fallback");
    expect(report.nodeRange).toEqual({ base: "cumulative-base", head: "tip" });
    expect(report.cumulativeRange).toEqual({
      base: "cumulative-base",
      head: "tip",
    });
  });

  it("evaluated:false → fail with the git-unavailable reason, nothing matched", () => {
    const { pass, report } = evaluate({
      evaluated: false,
      mustTouch: ["src/**"],
      mustNotTouch: "restrictions",
      restrictionSets: [{ id: "r", paths: ["x/**"] }],
    });

    expect(pass).toBe(false);
    expect(report.evaluated).toBe(false);
    expect(report.violations).toEqual([GIT_UNAVAILABLE_REASON]);
    expect(report.mustTouch.matched).toEqual([]);
    expect(report.restrictions.checked).toEqual([]);
  });

  it("carries the full D-C4 key set", () => {
    const { report } = evaluate({
      nodeTouched: ["src/a.ts"],
      mustTouch: ["src/**"],
    });

    expect(Object.keys(report).sort()).toEqual(
      [
        "basis",
        "nodeRange",
        "cumulativeRange",
        "touched",
        "truncated",
        "mustTouch",
        "restrictions",
        "violations",
        "evaluated",
      ].sort(),
    );
  });
});

// --- git-backed cases (real tmp repo) -------------------------------------

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });

  return stdout;
}

type Repo = { repo: string; branch: string; c0: string; c1: string };

// main: C0 (base.txt); feature branch: C1 adds src/a.ts + docs/readme.md.
async function makeRepo(): Promise<Repo> {
  const repo = await mkdtemp(join(tmpdir(), "mutation-check-"));

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@maister.local");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");

  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "C0 base");
  const c0 = (await git(repo, "rev-parse", "HEAD")).trim();

  await git(repo, "checkout", "-q", "-b", "feature");
  await execFileAsync("mkdir", ["-p", join(repo, "src"), join(repo, "docs")]);
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(repo, "docs", "readme.md"), "# docs\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "C1 add src+docs");
  const c1 = (await git(repo, "rev-parse", "HEAD")).trim();

  return { repo, branch: "feature", c0, c1 };
}

describe("touchedPaths (tmp git repo)", () => {
  it("returns the paths the range actually touched, repo-relative", async () => {
    const { repo, c0, c1 } = await makeRepo();

    const touched = await touchedPaths(repo, c0, c1);

    expect(touched.sort()).toEqual(["docs/readme.md", "src/a.ts"]);
  });

  it("returns [] for an empty range", async () => {
    const { repo, c1 } = await makeRepo();

    expect(await touchedPaths(repo, c1, c1)).toEqual([]);
  });

  it("returns non-ASCII paths unquoted (core.quotePath disabled)", async () => {
    const { repo, c1 } = await makeRepo();

    await writeFile(join(repo, "src", "тест-ü.ts"), "export const t = 1;\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "C2 unicode path");
    const c2 = (await git(repo, "rev-parse", "HEAD")).trim();

    const touched = await touchedPaths(repo, c1, c2);

    expect(touched).toEqual(["src/тест-ü.ts"]);
  });

  it("throws on a non-git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "not-a-repo-"));

    await expect(touchedPaths(dir, "a".repeat(40), "HEAD")).rejects.toThrow();
  });
});

describe("resolveDiffRange (extraction of the diff-artifact range)", () => {
  it("resolves merge-base vs main and the immutable head SHA", async () => {
    const { repo, branch, c0, c1 } = await makeRepo();

    const range = await resolveDiffRange({ worktreePath: repo, branch });

    expect(range.base).toBe(c0);
    expect(range.head).toBe(c1);
    expect(range.evaluated).toBe(true);
  });

  it("non-git dir → evaluated:false with EMPTY_TREE base + branch-name head", async () => {
    const dir = await mkdtemp(join(tmpdir(), "not-a-repo-"));

    const range = await resolveDiffRange({
      worktreePath: dir,
      branch: "feature/test",
    });

    expect(range.evaluated).toBe(false);
    expect(range.base).toBe(EMPTY_TREE);
    expect(range.head).toBe("feature/test");
  });
});

describe("node-start head capture (write-if-absent)", () => {
  it("captures once and preserves the FIRST head across a second write", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "run-dir-"));

    const first = await captureNodeStartHead(runDir, "implement", "sha-1");
    const second = await captureNodeStartHead(runDir, "implement", "sha-2");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await readNodeStartHead(runDir, "implement")).toBe("sha-1");
  });

  it("returns null when no capture exists", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "run-dir-"));

    expect(await readNodeStartHead(runDir, "implement")).toBeNull();
  });

  it("skips (no crash, no file) on a path-unsafe node id", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "run-dir-"));

    const written = await captureNodeStartHead(runDir, "../evil", "sha-1");

    expect(written).toBe(false);
    expect(await readNodeStartHead(runDir, "../evil")).toBeNull();
  });
});
