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

import { describe, expect, it } from "vitest";

import { prepareDiff } from "@/lib/diff/prepare";

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
