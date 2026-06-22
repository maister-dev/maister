import { describe, expect, it } from "vitest";

import { isScratchTranscriptClearCommand } from "@/lib/scratch-runs/commands";
import { normalizeScratchPrompt } from "@/lib/scratch-runs/events";

describe("normalizeScratchPrompt — scratch send seam (FR-E2/E5, T1.4)", () => {
  it("is a no-op on token-free text (verbatim-forward)", () => {
    const text = "fix the bug in /usr/bin and echo $HOME — no tokens here";

    expect(normalizeScratchPrompt(text, "codex", { runId: "r1" })).toBe(text);
  });

  it("expands a canonical skill token to the runner wire form", () => {
    expect(
      normalizeScratchPrompt("run @skill:plan", "codex", { runId: "r1" }),
    ).toBe("run $plan");
    expect(
      normalizeScratchPrompt("run @skill:plan", "claude", { runId: "r1" }),
    ).toBe("run /plan");
  });

  it("forwards plain slash commands verbatim", () => {
    expect(normalizeScratchPrompt("/clear", "claude", { runId: "r1" })).toBe(
      "/clear",
    );
    expect(normalizeScratchPrompt("/compact now", "claude", { runId: "r1" }))
      .toBe("/compact now");
  });

  it("recognizes only the exact clear command as a transcript reset", () => {
    expect(isScratchTranscriptClearCommand("/clear")).toBe(true);
    expect(isScratchTranscriptClearCommand(" /clear ")).toBe(true);
    expect(isScratchTranscriptClearCommand("/clear now")).toBe(false);
    expect(isScratchTranscriptClearCommand("please /clear")).toBe(false);
  });

  it("defaults a null/undefined runner to claude (tolerant)", () => {
    expect(normalizeScratchPrompt("@skill:plan", null, { runId: "r1" })).toBe(
      "/plan",
    );
    expect(
      normalizeScratchPrompt("@skill:plan", undefined, { runId: "r1" }),
    ).toBe("/plan");
  });

  it("degrades a subagent on a non-claude runner without throwing (WARN + proceed)", () => {
    expect(
      normalizeScratchPrompt("ask @agent:rev now", "codex", { runId: "r1" }),
    ).toBe("ask rev now");
  });
});
