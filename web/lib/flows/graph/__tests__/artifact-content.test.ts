import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/worktree", () => ({
  diffRange: vi.fn(),
  logRange: vi.fn(),
  DIFF_TRUNCATED_MARKER: "\n[diff-trunc]\n",
}));

import {
  ARTIFACT_TRUNCATED_MARKER,
  artifactContentToTemplateText,
  capForInline,
  resolveArtifactContent,
} from "@/lib/flows/graph/artifact-content";
import { isMaisterError } from "@/lib/errors";
import { diffRange, logRange } from "@/lib/worktree";

const mockedDiffRange = vi.mocked(diffRange);
const mockedLogRange = vi.mocked(logRange);

// A fake drizzle Db whose `.select().from().where()` resolves to `rows`.
function fakeDb(rows: unknown[]) {
  return {
    select: () => ({ from: () => ({ where: () => rows }) }),
  };
}

function ctx(over: Partial<Parameters<typeof resolveArtifactContent>[1]> = {}) {
  return {
    worktreePath: "/wt",
    projectSlug: "proj",
    runId: "run1",
    runtimeRoot: "/rt",
    db: fakeDb([]),
    ...over,
  } as Parameters<typeof resolveArtifactContent>[1];
}

describe("resolveArtifactContent — RAW (no cap, no divergence)", () => {
  beforeEach(() => {
    mockedDiffRange.mockReset();
    mockedLogRange.mockReset();
  });

  it("inline → full text, even >256 KiB (proves no cap in the resolver)", async () => {
    const big = "x".repeat(300 * 1024);
    const r = await resolveArtifactContent(
      { locator: { kind: "inline", text: big } },
      ctx(),
    );

    expect(r).toEqual({ kind: "text", text: big });
    if (r.kind === "text") expect(r.text.length).toBe(300 * 1024);
  });

  it("git-range → text from diffRange (preserves its own truncation marker)", async () => {
    mockedDiffRange.mockResolvedValue({ text: "DIFF", truncated: true });
    const r = await resolveArtifactContent(
      { locator: { kind: "git-range", baseCommit: "abc", headRef: "def" } },
      ctx(),
    );

    expect(r).toEqual({ kind: "text", text: "DIFF\n[diff-trunc]\n" });
  });

  it("git-range untruncated → text without marker", async () => {
    mockedDiffRange.mockResolvedValue({ text: "DIFF", truncated: false });
    const r = await resolveArtifactContent(
      { locator: { kind: "git-range", baseCommit: "abc", headRef: "def" } },
      ctx(),
    );

    expect(r).toEqual({ kind: "text", text: "DIFF" });
  });

  it("git-log → text from logRange", async () => {
    mockedLogRange.mockResolvedValue("abc123 commit");
    const r = await resolveArtifactContent(
      { locator: { kind: "git-log", baseRef: "abc", headRef: "def" } },
      ctx(),
    );

    expect(r).toEqual({ kind: "text", text: "abc123 commit" });
  });

  it("gate-verdict → json value from the runId-scoped row", async () => {
    const db = fakeDb([{ id: "g1", runId: "run1", verdict: { ok: true } }]);
    const r = await resolveArtifactContent(
      { locator: { kind: "gate-verdict", gateResultId: "g1" } },
      ctx({ db }),
    );

    expect(r).toEqual({ kind: "json", value: { ok: true } });
  });

  it("gate-verdict with no matching row → notfound", async () => {
    const r = await resolveArtifactContent(
      { locator: { kind: "gate-verdict", gateResultId: "g1" } },
      ctx({ db: fakeDb([]) }),
    );

    expect(r).toEqual({ kind: "notfound" });
  });

  it("hitl-response → json value from the runId-scoped row", async () => {
    const db = fakeDb([
      { id: "h1", runId: "run1", response: { answer: "yes" } },
    ]);
    const r = await resolveArtifactContent(
      { locator: { kind: "hitl-response", hitlRequestId: "h1" } },
      ctx({ db }),
    );

    expect(r).toEqual({ kind: "json", value: { answer: "yes" } });
  });
});

describe("resolveArtifactContent — file locator confinement", () => {
  let runtimeRoot: string;
  let runDir: string;

  beforeEach(async () => {
    runtimeRoot = await mkdtemp(join(tmpdir(), "artifact-content-rt-"));
    runDir = join(runtimeRoot, ".maister", "proj", "runs", "run1");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  it("file inside the run dir → full content", async () => {
    await writeFile(join(runDir, "report.txt"), "hello world", "utf8");
    const r = await resolveArtifactContent(
      { locator: { kind: "file", path: "report.txt" } },
      ctx({ runtimeRoot }),
    );

    expect(r).toEqual({ kind: "text", text: "hello world" });
  });

  it("`../` traversal → notfound (rejected lexically, no fs read)", async () => {
    const r = await resolveArtifactContent(
      { locator: { kind: "file", path: "../../../../../../etc/hosts" } },
      ctx({ runtimeRoot }),
    );

    expect(r).toEqual({ kind: "notfound" });
  });

  it("symlink escaping the run dir → notfound", async () => {
    const outside = join(runtimeRoot, "secret.txt");

    await writeFile(outside, "secret", "utf8");
    await symlink(outside, join(runDir, "link.txt"));
    const r = await resolveArtifactContent(
      { locator: { kind: "file", path: "link.txt" } },
      ctx({ runtimeRoot }),
    );

    expect(r).toEqual({ kind: "notfound" });
  });

  it("missing file inside the run dir → gone", async () => {
    const r = await resolveArtifactContent(
      { locator: { kind: "file", path: "missing.txt" } },
      ctx({ runtimeRoot }),
    );

    expect(r).toEqual({ kind: "gone" });
  });

  // Codex finding #2: the injection path passes ctx.maxBytes to bound the read so
  // a huge file artifact never loads its full payload into the web process.
  it("reads AT MOST ctx.maxBytes bytes (bounded read, no full-file load)", async () => {
    await writeFile(join(runDir, "big.txt"), "A".repeat(100_000), "utf8");
    const r = await resolveArtifactContent(
      { locator: { kind: "file", path: "big.txt" } },
      ctx({ runtimeRoot, maxBytes: 10 }),
    );

    expect(r.kind).toBe("text");
    if (r.kind === "text") {
      expect(r.text).toBe("AAAAAAAAAA"); // exactly 10 bytes, not 100k
      expect(r.text.length).toBe(10);
    }
  });

  it("with no maxBytes (route path) reads the FULL file", async () => {
    await writeFile(join(runDir, "full.txt"), "B".repeat(50_000), "utf8");
    const r = await resolveArtifactContent(
      { locator: { kind: "file", path: "full.txt" } },
      ctx({ runtimeRoot }),
    );

    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.text.length).toBe(50_000);
  });
});

describe("artifactContentToTemplateText (D9)", () => {
  it("text → text", () => {
    expect(
      artifactContentToTemplateText({ kind: "text", text: "abc" }, "x"),
    ).toBe("abc");
  });

  it("json → pretty-printed JSON (never [object Object])", () => {
    const out = artifactContentToTemplateText(
      { kind: "json", value: { a: 1, b: [2, 3] } },
      "x",
    );

    expect(out).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
    expect(out).not.toContain("[object Object]");
  });

  it("gone → CONFIG", () => {
    try {
      artifactContentToTemplateText({ kind: "gone" }, "x");
      expect.unreachable();
    } catch (err) {
      expect(isMaisterError(err) && err.code).toBe("CONFIG");
    }
  });

  it("notfound → CONFIG", () => {
    try {
      artifactContentToTemplateText({ kind: "notfound" }, "x");
      expect.unreachable();
    } catch (err) {
      expect(isMaisterError(err) && err.code).toBe("CONFIG");
    }
  });
});

describe("capForInline (D3)", () => {
  afterEach(() => {
    delete process.env.MAISTER_ARTIFACT_INLINE_MAX_BYTES;
  });

  it("under cap → untouched, truncated:false", () => {
    expect(capForInline("small")).toEqual({ text: "small", truncated: false });
  });

  it("over cap → truncated + marker, truncated:true", () => {
    process.env.MAISTER_ARTIFACT_INLINE_MAX_BYTES = "10";
    const r = capForInline("0123456789ABCDEF");

    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("0123456789")).toBe(true);
    expect(r.text.endsWith(ARTIFACT_TRUNCATED_MARKER)).toBe(true);
  });

  it("honors the MAISTER_ARTIFACT_INLINE_MAX_BYTES override", () => {
    process.env.MAISTER_ARTIFACT_INLINE_MAX_BYTES = "100000";
    expect(capForInline("x".repeat(50_000)).truncated).toBe(false);
  });

  it("does not split a multibyte UTF-8 sequence at the boundary", () => {
    // '€' is 3 bytes (E2 82 AC). Cap at 4 bytes: one full '€' fits (3 bytes),
    // the second '€' would cross the boundary and must be dropped whole.
    process.env.MAISTER_ARTIFACT_INLINE_MAX_BYTES = "4";
    const r = capForInline("€€€");

    expect(r.truncated).toBe(true);
    // The head before the marker decodes cleanly (no U+FFFD replacement char).
    const head = r.text.slice(
      0,
      r.text.length - ARTIFACT_TRUNCATED_MARKER.length,
    );

    expect(head).toBe("€");
    expect(head).not.toContain("�");
  });
});
