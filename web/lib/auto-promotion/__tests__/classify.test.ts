import type { AutoPromotionConfig } from "@/lib/auto-promotion/config";
import type { DiffChangeStatEntry } from "@/lib/worktree";

import { describe, expect, it } from "vitest";

import { classifyDiff } from "@/lib/auto-promotion/classify";
import { BUILT_IN_LANES } from "@/lib/auto-promotion/config";

function file(
  path: string,
  status = "M",
  oldPath?: string,
): DiffChangeStatEntry {
  return { path, status, oldPath, additions: 1, deletions: 0, binary: false };
}

const ALL_LANES: AutoPromotionConfig = { enabled: true, lanes: BUILT_IN_LANES };

describe("classifyDiff — lane assignment", () => {
  it("docs-only ⇒ eligible docs", () => {
    expect(
      classifyDiff([file("README.md"), file("docs/a.md")], ALL_LANES),
    ).toEqual({
      kind: "eligible",
      lane: "docs",
    });
  });

  it("empty diff ⇒ empty_diff", () => {
    expect(classifyDiff([], ALL_LANES)).toEqual({ kind: "empty_diff" });
  });

  it("docs + one source file ⇒ no_lane (names the offender)", () => {
    const v = classifyDiff([file("README.md"), file("src/x.ts")], ALL_LANES);

    expect(v.kind).toBe("no_lane");
    expect(v.kind === "no_lane" && v.files).toContain("src/x.ts");
  });

  it("test-file deletion ⇒ tests", () => {
    expect(classifyDiff([file("lib/x.test.ts", "D")], ALL_LANES)).toEqual({
      kind: "eligible",
      lane: "tests",
    });
  });

  it("config dotfiles (.prettierrc + eslint.config.js) ⇒ config", () => {
    expect(
      classifyDiff([file(".prettierrc"), file("eslint.config.js")], ALL_LANES),
    ).toEqual({ kind: "eligible", lane: "config" });
  });

  it("binary image under docs/ ⇒ docs", () => {
    const img = { ...file("docs/img/logo.png", "A"), binary: true };

    expect(classifyDiff([img], ALL_LANES)).toEqual({
      kind: "eligible",
      lane: "docs",
    });
  });

  it("tsconfig.json ⇒ no_lane (deliberately excluded from config lane)", () => {
    expect(classifyDiff([file("tsconfig.json")], ALL_LANES).kind).toBe(
      "no_lane",
    );
  });

  it("Dockerfile ⇒ no_lane", () => {
    expect(classifyDiff([file("Dockerfile")], ALL_LANES).kind).toBe("no_lane");
  });
});

describe("classifyDiff — renames evaluate both endpoints", () => {
  it("rename within docs ⇒ docs", () => {
    expect(
      classifyDiff([file("docs/b.md", "R100", "docs/a.md")], ALL_LANES),
    ).toEqual({ kind: "eligible", lane: "docs" });
  });

  it("rename src → docs ⇒ no_lane (oldPath is not docs)", () => {
    expect(
      classifyDiff([file("docs/x.md", "R100", "src/x.ts")], ALL_LANES).kind,
    ).toBe("no_lane");
  });
});

describe("classifyDiff — deny-list defeats every lane (path + oldPath)", () => {
  it.each([
    ["CLAUDE.md"],
    ["docs/nested/CLAUDE.md"],
    [".github/workflows/ci.yml"],
    [".env.local"],
    ["web/.env.production"],
    ["maister.yaml"],
    [".claude/settings.json"],
    [".codex/config.toml"],
    [".ai-factory/plans/x.md"],
    ["AGENTS.md"],
  ])("%s ⇒ denied", (path) => {
    const v = classifyDiff([file(path)], ALL_LANES);

    expect(v.kind).toBe("denied");
    expect(v.kind === "denied" && v.files).toContain(path);
  });

  it("rename INTO .claude/ (deny on new path) ⇒ denied", () => {
    expect(
      classifyDiff([file(".claude/x.json", "R100", "docs/x.md")], ALL_LANES)
        .kind,
    ).toBe("denied");
  });

  it("rename OUT of .env (deny on oldPath) ⇒ denied", () => {
    expect(
      classifyDiff([file("docs/x.md", "R100", ".env.local")], ALL_LANES).kind,
    ).toBe("denied");
  });
});

describe("classifyDiff — non-disjoint globs produce ambiguous_lane (H2)", () => {
  // The built-in globs are deliberately NOT disjoint; a file claimed by ≥2
  // enabled lanes MUST surface as ambiguous_lane, never be forced into one.
  it.each([
    ["x/__tests__/notes.md"], // docs (**/*.md) ∧ tests (**/__tests__/**)
    ["x/__fixtures__/package.json"], // deps (**/package.json) ∧ tests (**/__fixtures__/**)
    ["e2e/readme.md"], // docs (**/*.md) ∧ tests (e2e/**)
  ])("%s ⇒ ambiguous_lane", (path) => {
    const v = classifyDiff([file(path)], ALL_LANES);

    expect(v.kind).toBe("ambiguous_lane");
    expect(v.kind === "ambiguous_lane" && v.files).toContain(path);
  });

  it("property: no single file is silently forced into one lane when it matches two", () => {
    // Sanity that the fixtures above are genuine overlaps, not typos.
    const overlaps = ["x/__tests__/notes.md", "x/__fixtures__/package.json"];

    for (const p of overlaps) {
      expect(classifyDiff([file(p)], ALL_LANES).kind).toBe("ambiguous_lane");
    }
  });
});

describe("classifyDiff — mixed single-match lanes ⇒ no_lane", () => {
  it("docs + test file (each single-match, different lanes) ⇒ no_lane", () => {
    expect(
      classifyDiff([file("README.md"), file("lib/x.test.ts")], ALL_LANES).kind,
    ).toBe("no_lane");
  });
});

describe("classifyDiff — excludeGlobs subtract a lane (fail-to-manual)", () => {
  it("an excluded file matches 0 lanes ⇒ no_lane", () => {
    const cfg: AutoPromotionConfig = {
      enabled: true,
      lanes: [
        {
          class: "docs",
          enabled: true,
          delayMinutes: 10,
          excludeGlobs: ["docs/CHANGELOG.md"],
        },
      ],
    };

    expect(classifyDiff([file("docs/CHANGELOG.md")], cfg).kind).toBe("no_lane");
    // a non-excluded doc still promotes on the same lane config
    expect(classifyDiff([file("docs/guide.md")], cfg)).toEqual({
      kind: "eligible",
      lane: "docs",
    });
  });
});
