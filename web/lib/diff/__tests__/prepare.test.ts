// Phase 2 (T2.3, RED): failing contract tests for the server diff-prep that
// turns a raw unified `git diff` into the explicit CLIENT DTO the diff view
// hydrates. The module `web/lib/diff/prepare.ts` does not exist yet — these
// tests RED on the missing import (`@/lib/diff/prepare`).
//
// Style: node env, no jsdom; the async prep is awaited DIRECTLY (no React),
// mirroring `lib/**/__tests__` pure-helper tests. `.test.ts` matches the `unit`
// project glob (`lib/**/__tests__/**/*.test.ts`).
//
// Frozen interface (architect-fixed — ADR-066, plan T2.3):
//   export async function prepareDiff(rawDiff: string, truncated?: boolean): Promise<DiffPrepResult>
//   DiffPrepResult  = { files: DiffFileSummary[]; perFile: PreparedFile[]; truncated: boolean }
//   DiffFileSummary = { path: string; status: string; additions: number; deletions: number }
//   PreparedFile    = { path: string; fileLang: string; bundle: unknown }
//
// `truncated` (default false) is threaded straight onto the DTO — the producing
// diff reader sets it when the diff was cut at EXEC_MAX_BUFFER. It never alters
// parsing; a review surface blocks on it so a partial diff is not promoted.
//
// The output is an explicit CLIENT DTO (FINDING C / `#response-leak` rule):
//   - repo-relative `path` only (strip `a/`, `b/`)
//   - NOTHING that is an absolute worktree path or a server-only handle anywhere
//     in the structure (incl. inside `bundle` / any `fileName`)
//   - `prepareDiff` takes ONLY the rawDiff — it MUST NOT need or embed a repo path.
//
// Assertions are BEHAVIOR/CONTRACT-focused and resilient to git-diff-view
// internals — we assert the DTO surface (counts, status, repo-relative paths,
// per-file split, no-leak), NOT the internal `bundle` token tree.

import {
  DiffFile,
  getEnableBuildTemplate,
  setEnableBuildTemplate,
} from "@git-diff-view/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DIFF_YIELD_BATCH_SIZE,
  filterDiffByPath,
  MAX_TOTAL_SYNTAX_LINES,
  prepareDiff,
  prepareDiffSummary,
} from "@/lib/diff/prepare";
import { shikiDiffHighlighter } from "@/lib/diff/shiki-adapter";
import { isReviewableChangeEntry } from "@/lib/runs/reviewable-changes";

// A realistic 2-file unified diff:
//   src/a.ts — modified: 2 additions, 1 deletion
//   b.ts     — added:    1 addition,  0 deletions
// `+++`/`---` header lines are NOT data lines and MUST be excluded from counts.
const TWO_FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const keep = 0;",
  "-const old = 1;",
  "+const next = 1;",
  "+const extra = 2;",
  "diff --git a/b.ts b/b.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/b.ts",
  "@@ -0,0 +1 @@",
  "+export const b = true;",
].join("\n");

describe("prepareDiff — files summary (counts / status / repo-relative path)", () => {
  it("emits one files[] entry per changed file with correct +/- counts", async () => {
    const result = await prepareDiff(TWO_FILE_DIFF);

    expect(result.files).toHaveLength(2);

    const a = result.files.find((f) => f.path === "src/a.ts");
    const b = result.files.find((f) => f.path === "b.ts");

    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // src/a.ts: 2 `+` data lines, 1 `-` data line (the `+++`/`---` headers
    // are excluded).
    expect(a?.additions).toBe(2);
    expect(a?.deletions).toBe(1);

    // b.ts: 1 `+` data line, 0 deletions.
    expect(b?.additions).toBe(1);
    expect(b?.deletions).toBe(0);
  });

  it("reports a status for each file", async () => {
    const result = await prepareDiff(TWO_FILE_DIFF);

    for (const file of result.files) {
      expect(typeof file.status).toBe("string");
      expect(file.status.length).toBeGreaterThan(0);
    }
  });

  it("uses repo-relative paths (strips the a/ b/ diff prefixes)", async () => {
    const result = await prepareDiff(TWO_FILE_DIFF);

    for (const file of result.files) {
      expect(file.path.startsWith("a/")).toBe(false);
      expect(file.path.startsWith("b/")).toBe(false);
    }
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "b.ts",
      "src/a.ts",
    ]);
  });
});

describe("filterDiffByPath — reviewable section filtering", () => {
  it("removes whole unified-diff sections by repo-relative path", () => {
    const filtered = filterDiffByPath(TWO_FILE_DIFF, (path) => path !== "b.ts");
    const summary = prepareDiffSummary(filtered);

    expect(summary.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(filtered).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(filtered).not.toContain("diff --git a/b.ts b/b.ts");
  });

  it("excludes renames and copies crossing materialized paths in either direction", () => {
    const crossingDiff = [
      "diff --git a/.claude/agents/reviewer.md b/src/reviewer.md",
      "similarity index 100%",
      "rename from .claude/agents/reviewer.md",
      "rename to src/reviewer.md",
      "diff --git a/src/copied.ts b/.claude/skills/aif-review/SKILL.md",
      "similarity index 100%",
      "copy from src/copied.ts",
      "copy to .claude/skills/aif-review/SKILL.md",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");

    const filtered = filterDiffByPath(crossingDiff, (path, oldPath) =>
      isReviewableChangeEntry({ path, oldPath }),
    );

    expect(filtered).toContain("diff --git a/src/old.ts b/src/new.ts");
    expect(filtered).not.toContain(
      "diff --git a/.claude/agents/reviewer.md b/src/reviewer.md",
    );
    expect(filtered).not.toContain(
      "diff --git a/src/copied.ts b/.claude/skills/aif-review/SKILL.md",
    );
  });
});

describe("prepareDiff — perFile split + payload", () => {
  it("emits one perFile entry per file, each carrying fileLang + bundle", async () => {
    const result = await prepareDiff(TWO_FILE_DIFF);

    expect(result.perFile).toHaveLength(2);

    for (const file of result.perFile) {
      expect(typeof file.path).toBe("string");
      expect(typeof file.fileLang).toBe("string");
      // `bundle` is the server-built (Shiki-highlighted) hydration payload; we
      // only assert it is present, never its internal shape.
      expect(file.bundle).toBeDefined();
    }
  });

  it("splits the two files apart (mirrors extractFileSection's diff --git split)", async () => {
    const result = await prepareDiff(TWO_FILE_DIFF);

    const paths = result.perFile.map((f) => f.path).sort();

    expect(paths).toEqual(["b.ts", "src/a.ts"]);
  });

  it("resolves a TypeScript fileLang for a .ts file", async () => {
    const result = await prepareDiff(TWO_FILE_DIFF);

    const a = result.perFile.find((f) => f.path === "src/a.ts");

    // langFromPath maps .ts → typescript; assert the lang resolves rather than
    // pinning the diff highlighter's exact id beyond the stable ts mapping.
    expect(a?.fileLang).toBe("typescript");
  });
});

describe("prepareDiff — compact serializable rich payload", () => {
  const markdown = Array.from(
    { length: 60 },
    (_, index) =>
      `- [ ] Item ${index + 1}: keep generated syntax payload bounded for markdown diff rendering.`,
  ).join("\n");

  const markdownDiff = `${[
    "diff --git a/docs/plan.md b/docs/plan.md",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/docs/plan.md",
    "@@ -0,0 +1,60 @@",
    ...markdown.split("\n").map((line) => `+${line}`),
  ].join("\n")}\n`;

  it("strips server-only syntax wrapper trees before returning the client DTO", async () => {
    const result = await prepareDiff(markdownDiff);
    const serialized = JSON.stringify(result);

    expect(result.files).toHaveLength(1);
    expect(result.perFile).toHaveLength(1);
    expect(serialized.length).toBeLessThan(1_000_000);
    expect(serialized).not.toContain('"ast"');
    expect(serialized).not.toContain('"children"');
    expect(serialized).not.toContain('"template"');
  });
});

describe("prepareDiff — binary + empty inputs do not throw", () => {
  it("handles a binary-file section without throwing, returning a well-formed DTO", async () => {
    const binaryDiff = [
      "diff --git a/x.png b/x.png",
      "index 4444444..5555555 100644",
      "Binary files a/x.png and b/x.png differ",
    ].join("\n");

    const result = await prepareDiff(binaryDiff);

    // The DTO is well-formed (both arrays present). The Implementor MAY include
    // the binary file (with 0/0 counts) OR skip it — either is acceptable; we
    // only require no throw + a structurally valid result.
    expect(Array.isArray(result.files)).toBe(true);
    expect(Array.isArray(result.perFile)).toBe(true);

    const png = result.files.find((f) => f.path === "x.png");

    if (png) {
      expect(png.additions).toBe(0);
      expect(png.deletions).toBe(0);
    }
  });

  it("handles an empty diff ('') without throwing, returning empty arrays", async () => {
    const result = await prepareDiff("");

    expect(result.files).toEqual([]);
    expect(result.perFile).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe("prepareDiff — truncation flag (regression: silent partial diff)", () => {
  it("defaults truncated to false and threads an explicit true", async () => {
    const whole = await prepareDiff(TWO_FILE_DIFF);

    expect(whole.truncated).toBe(false);

    const cut = await prepareDiff(TWO_FILE_DIFF, true);

    // The flag never alters parsing — the surviving sections still project.
    expect(cut.truncated).toBe(true);
    expect(cut.files).toHaveLength(2);
    expect(cut.perFile).toHaveLength(2);
  });

  it("carries truncated even when the surviving prefix has no parseable section", async () => {
    const empty = await prepareDiff("", true);

    expect(empty.files).toEqual([]);
    expect(empty.perFile).toEqual([]);
    expect(empty.truncated).toBe(true);
  });
});

describe("prepareDiff — no server-only leak (FINDING C)", () => {
  // A diff whose CONTENT mentions an absolute path: it must appear ONLY where it
  // legitimately lives in the diff text (inside a perFile bundle's line content
  // is fine — that is the actual changed source), but the DTO must never invent
  // an absolute `path`/`fileName`, and must never carry a server-only handle.
  const DIFF_WITH_ABSOLUTE_IN_CONTENT = [
    "diff --git a/config.ts b/config.ts",
    "index 6666666..7777777 100644",
    "--- a/config.ts",
    "+++ b/config.ts",
    "@@ -1 +1 @@",
    '-const root = "/tmp/old";',
    '+const root = "/var/data/new";',
  ].join("\n");

  it("never embeds an absolute worktree path as a file path/fileName", async () => {
    const result = await prepareDiff(DIFF_WITH_ABSOLUTE_IN_CONTENT);

    // Every projected file path is repo-relative, never absolute.
    for (const file of result.files) {
      expect(file.path.startsWith("/")).toBe(false);
    }
    for (const file of result.perFile) {
      expect(file.path.startsWith("/")).toBe(false);
    }
  });

  it("never carries a worktree path or a server-only handle key in the DTO", async () => {
    // A clean fixture with NO absolute path anywhere: `prepareDiff` is given the
    // rawDiff ONLY (it must not need or embed the repo path), so any `/Users/` or
    // server-only handle key in the serialized DTO could only be a server-side
    // injection — exactly the FINDING C leak this asserts against.
    const diff = [
      "diff --git a/app.ts b/app.ts",
      "index 8888888..9999999 100644",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1 +1 @@",
      '-import x from "./x";',
      '+import x from "./y";',
    ].join("\n");

    const result = await prepareDiff(diff);
    const json = JSON.stringify(result);

    // No absolute-path marker anywhere in the serialized DTO (the fixture above
    // contains none, so any /Users/ or absolute worktree segment would be an
    // injected server-side leak).
    expect(json).not.toContain("/Users/");
    expect(json).not.toContain("worktree_path");
    expect(json).not.toContain("repo_path");

    // No server-only handle KEYS anywhere in the structure.
    for (const key of [
      "worktree",
      "worktreePath",
      "acp_session_id",
      "acpSessionId",
      "repoPath",
    ]) {
      expect(json).not.toContain(`"${key}"`);
    }
  });
});

describe("prepareDiff — trailing-byte fidelity of the final data line", () => {
  // Deliberate exception to the no-bundle-internals stance above: these pin
  // PARSE-BYTE fidelity through the per-side line records — the exact surface
  // review-comment anchoring (lib/review-comments/anchor.ts) matches
  // byte-exactly. splitSections must strip ONLY the git stdout "\n"
  // terminator, never trailing spaces or a CRLF line's "\r".
  const lineText = async (
    diff: string,
    line: string,
  ): Promise<string | undefined> => {
    const result = await prepareDiff(diff);
    const bundle = result.perFile[0]?.bundle as unknown as {
      newFileDiffLines: Record<string, { text?: string }>;
    };

    return bundle.newFileDiffLines[line]?.text;
  };

  const singleAddedLineDiff = (added: string): string =>
    `${[
      "diff --git a/app.ts b/app.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/app.ts",
      "@@ -0,0 +1 @@",
      `+${added}`,
    ].join("\n")}\n`;

  it("keeps trailing spaces on the physical last data line", async () => {
    expect(await lineText(singleAddedLineDiff("const p = 1;  "), "1")).toBe(
      "const p = 1;  ",
    );
  });

  it("keeps the CR byte of a CRLF final data line", async () => {
    expect(await lineText(singleAddedLineDiff("const q = 2;\r"), "1")).toBe(
      "const q = 2;\r",
    );
  });

  it("keeps trailing spaces when a context line follows (non-final position)", async () => {
    const diff = `${[
      "diff --git a/app.ts b/app.ts",
      "index 1111111..2222222 100644",
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1 +1,2 @@",
      "+const p = 1;  ",
      " const tail = 3;",
    ].join("\n")}\n`;

    // Non-final data lines keep their "\n"; the significant spaces precede it.
    expect(await lineText(diff, "1")).toBe("const p = 1;  \n");
  });
});

function buildAddedTsSection(
  path: string,
  lineCount: number,
  tag = path.replace(/[^a-zA-Z0-9_]/g, "_"),
): string {
  const body = Array.from(
    { length: lineCount },
    (_, i) => `+export const ${tag}_${i + 1} = ${i + 1};`,
  );

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lineCount} @@`,
    ...body,
  ].join("\n");
}

function assertSanitizedPlainTree(value: unknown, path = "root"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value), `${path} array proto`).toBe(
      Array.prototype,
    );
    for (let i = 0; i < value.length; i += 1) {
      assertSanitizedPlainTree(value[i], `${path}[${i}]`);
    }

    return;
  }

  expect(Object.getPrototypeOf(value), `${path} object proto`).toBe(
    Object.prototype,
  );

  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    expect(
      ["ast", "plainTemplate", "syntaxTemplate", "template"],
      `${path}.${key} omitted`,
    ).not.toContain(key);

    const child = record[key];

    if (
      key === "wrapper" &&
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      expect(
        Object.keys(child as Record<string, unknown>).every(
          (wrapperKey) => wrapperKey === "properties",
        ),
        `${path}.wrapper slimmed to properties only`,
      ).toBe(true);
    }

    assertSanitizedPlainTree(child, `${path}.${key}`);
  }
}

describe("prepareDiff — syntax budget, yield safety & single-pass sanitizer (PERF-12)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enforces MAX_TOTAL_SYNTAX_LINES and hydrates downgraded plaintext bundles with zero lowlight fallback", async () => {
    expect(MAX_TOTAL_SYNTAX_LINES).toBe(8_000);

    // 5 files × 1,500 lines = 7,500 lines (within both 2,000 per-file cap and
    // 8,000 total budget); file 6 (1,500 lines) crosses 8,000 and file 7
    // (50 lines) is trailing — both must bypass Shiki WASM.
    const multiFileDiff = [
      ...Array.from({ length: 6 }, (_, i) =>
        buildAddedTsSection(`src/part-${i}.ts`, 1_500),
      ),
      buildAddedTsSection("src/tail.ts", 50),
    ].join("\n");

    const shikiAstSpy = vi.spyOn(shikiDiffHighlighter, "getAST");

    const result = await prepareDiff(multiFileDiff);

    expect(result.perFile).toHaveLength(7);

    const highlightedFileNames = new Set(
      shikiAstSpy.mock.calls.map((call) => call[1]),
    );

    expect(highlightedFileNames).toEqual(
      new Set([
        "src/part-0.ts",
        "src/part-1.ts",
        "src/part-2.ts",
        "src/part-3.ts",
        "src/part-4.ts",
      ]),
    );
    expect(highlightedFileNames.has("src/part-5.ts")).toBe(false);
    expect(highlightedFileNames.has("src/tail.ts")).toBe(false);

    const trailing = result.perFile.find((f) => f.path === "src/part-5.ts");
    const tail = result.perFile.find((f) => f.path === "src/tail.ts");

    expect(trailing).toBeDefined();
    expect(tail).toBeDefined();
    expect(trailing?.fileLang).toBe("plaintext");
    expect(tail?.fileLang).toBe("plaintext");

    // Hydrate the downgraded bundle exactly as DiffView does on the client
    // (no registerHighlighter): must early-return with zero client lowlight
    // fallback (ADR-066 FINDING G) while rendering valid plaintext lines.
    const hydrated = DiffFile.createInstance(
      {
        oldFile: { fileName: trailing!.path, fileLang: trailing!.fileLang },
        newFile: { fileName: trailing!.path, fileLang: trailing!.fileLang },
      },
      trailing!.bundle,
    );

    hydrated.initSyntax();

    expect(hydrated._getHighlighterName()).toBe("plaintext");
    expect(hydrated.getNewSyntaxLine(1)).toBeUndefined();
    expect(hydrated.unifiedLineLength).toBeGreaterThan(0);
    expect(hydrated.splitLineLength).toBeGreaterThan(0);
    expect(hydrated.getUnifiedLine(0)?.value).toContain(
      "export const src_part_5_ts_1 = 1;",
    );
    expect(hydrated.getSplitRightLine(0)?.value).toContain(
      "export const src_part_5_ts_1 = 1;",
    );
    expect(hydrated.getNewPlainLine(1)?.value).toContain(
      "export const src_part_5_ts_1 = 1;",
    );
  });

  it("yields the event loop between batches without corrupting getEnableBuildTemplate across concurrent calls", async () => {
    expect(DIFF_YIELD_BATCH_SIZE).toBe(5);

    // Warm Shiki + TypeScript grammar so preloadDiffLangs settles via microtask
    // and any setImmediate interleave must come from prepareDiff's batch yields.
    await prepareDiff(TWO_FILE_DIFF);

    const diffA = Array.from({ length: 12 }, (_, i) =>
      buildAddedTsSection(`src/mod-a-${i}.ts`, 15, `modA_${i}`),
    ).join("\n");
    const diffB = Array.from({ length: 12 }, (_, i) =>
      buildAddedTsSection(`src/mod-b-${i}.ts`, 15, `modB_${i}`),
    ).join("\n");

    const initialFlag = getEnableBuildTemplate();

    setEnableBuildTemplate(true);

    try {
      const shikiAstSpy = vi.spyOn(shikiDiffHighlighter, "getAST");
      let callsObservedMidFlight = 0;
      let flagObservedDuringYield: boolean | null = null;
      let bothDone = false;

      const runs = Promise.all([prepareDiff(diffA), prepareDiff(diffB)]).then(
        (res) => {
          bothDone = true;

          return res;
        },
      );

      const yieldProbe = new Promise<void>((resolve) => {
        setImmediate(() => {
          if (!bothDone) {
            callsObservedMidFlight = shikiAstSpy.mock.calls.length;
            flagObservedDuringYield = getEnableBuildTemplate();
          }
          resolve();
        });
      });

      const [[first, second]] = await Promise.all([runs, yieldProbe]);

      expect(callsObservedMidFlight).toBeGreaterThan(0);
      expect(callsObservedMidFlight).toBeLessThan(
        shikiAstSpy.mock.calls.length,
      );
      expect(flagObservedDuringYield).toBe(true);
      expect(getEnableBuildTemplate()).toBe(true);
      expect(first.perFile).toHaveLength(12);
      expect(second.perFile).toHaveLength(12);
    } finally {
      setEnableBuildTemplate(initialFlag);
    }
  });

  it("sanitizes bundles to plain prototypes in a single pass without calling JSON.parse", async () => {
    const jsonParseSpy = vi.spyOn(JSON, "parse");
    const result = await prepareDiff(TWO_FILE_DIFF);

    expect(jsonParseSpy).not.toHaveBeenCalled();
    assertSanitizedPlainTree(result);

    jsonParseSpy.mockRestore();
    expect(result).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it("downgrades a leading file exceeding maxLineToIgnoreSyntax without starving subsequent small files", async () => {
    const oversizedPlusSmall = [
      buildAddedTsSection("pnpm-lock.yaml", 3_000, "lock"),
      buildAddedTsSection("src/feature.ts", 50, "feat"),
    ].join("\n");

    const shikiAstSpy = vi.spyOn(shikiDiffHighlighter, "getAST");
    const result = await prepareDiff(oversizedPlusSmall);

    expect(result.perFile).toHaveLength(2);

    const lockFile = result.perFile.find((f) => f.path === "pnpm-lock.yaml");
    const featureFile = result.perFile.find((f) => f.path === "src/feature.ts");

    expect(lockFile?.fileLang).toBe("plaintext");
    expect(featureFile?.fileLang).toBe("typescript");

    const highlightedPaths = new Set(
      shikiAstSpy.mock.calls.map((call) => call[1]),
    );

    expect(highlightedPaths.has("pnpm-lock.yaml")).toBe(false);
    expect(highlightedPaths.has("src/feature.ts")).toBe(true);
  });

  it("restores getEnableBuildTemplate() when buildBundle throws", async () => {
    const initialFlag = getEnableBuildTemplate();

    setEnableBuildTemplate(true);
    try {
      vi.spyOn(shikiDiffHighlighter, "getAST").mockImplementationOnce(() => {
        throw new Error("simulated shiki failure");
      });

      await expect(prepareDiff(TWO_FILE_DIFF)).rejects.toThrow(
        "simulated shiki failure",
      );
      expect(getEnableBuildTemplate()).toBe(true);
    } finally {
      setEnableBuildTemplate(initialFlag);
    }
  });
});
