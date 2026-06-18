import { describe, expect, it } from "vitest";

import { classifyGhResult } from "@/lib/repo-source";

// ADR-093: best-effort GitHub auth via the host `gh` CLI. classifyGhResult is
// the pure core of detectGhAuth — testable without a real `gh` on the host.
describe("classifyGhResult", () => {
  it("ok when gh exits 0 with a token", () => {
    expect(
      classifyGhResult({ ok: true, token: "ghp_x\n", notFound: false }),
    ).toBe("ok");
  });

  it("unauthed when gh exits non-zero (not logged in)", () => {
    expect(classifyGhResult({ ok: false, token: "", notFound: false })).toBe(
      "unauthed",
    );
  });

  it("unauthed when gh returns an empty/whitespace token", () => {
    expect(classifyGhResult({ ok: true, token: "  \n", notFound: false })).toBe(
      "unauthed",
    );
  });

  it("absent when gh is not installed (ENOENT)", () => {
    expect(classifyGhResult({ ok: false, token: "", notFound: true })).toBe(
      "absent",
    );
  });
});
