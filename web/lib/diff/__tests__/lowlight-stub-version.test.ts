import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { versions } from "@/lib/diff/lowlight-stub";

// FINDING G / ADR-066 guard: `lib/diff/lowlight-stub.ts` is a hand-vendored,
// grammar-free replacement for `@git-diff-view/lowlight` (aliased in
// next.config.mjs). Its `processAST` is a verbatim port pinned to a specific
// `@git-diff-view` release, and `@git-diff-view/core`/`/react` are exact-pinned
// for exactly this reason. If the dep is ever bumped without re-syncing the
// stub, the merged-syntax contract can silently drift — this test fails on that
// bump so the stub is reviewed in lockstep.
const pkg = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../package.json",
    ),
    "utf8",
  ),
) as { dependencies: Record<string, string> };

describe("lowlight-stub version guard", () => {
  it("tracks the exact-pinned @git-diff-view/core version", () => {
    expect(versions).toBe(pkg.dependencies["@git-diff-view/core"]);
  });

  it("keeps @git-diff-view/core and /react pinned to the same exact version", () => {
    expect(pkg.dependencies["@git-diff-view/react"]).toBe(
      pkg.dependencies["@git-diff-view/core"],
    );
    expect(pkg.dependencies["@git-diff-view/core"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
