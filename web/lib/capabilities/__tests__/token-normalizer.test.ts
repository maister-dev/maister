import { describe, expect, it } from "vitest";

import { ADAPTER_IDS, type AdapterId } from "@/lib/acp-runners/adapter-support";
import {
  normalizeCapabilityTokens,
  surfaceFormForSkill,
} from "@/lib/capabilities/token-normalizer";

// Frozen surface forms (flow-settings.md FROZEN SPEC + acp-runners.md T0.4):
// skill  → claude `/slug`, codex `$slug`, gemini/opencode/mimo `/slug`
// subagent → `@name` claude-only; other runners advisory (WARN + degrade)
const SKILL_SIGIL: Record<AdapterId, string> = {
  claude: "/",
  codex: "$",
  gemini: "/",
  opencode: "/",
  mimo: "/",
};

describe("normalizeCapabilityTokens — canonical skill expansion (FR-E2)", () => {
  for (const agent of ADAPTER_IDS) {
    it(`expands @skill:<slug> to the ${agent} wire form`, () => {
      const out = normalizeCapabilityTokens("run @skill:aif-plan now", agent);

      expect(out.text).toBe(`run ${SKILL_SIGIL[agent]}aif-plan now`);
      expect(out.warnings).toHaveLength(0);
    });
  }

  it("expands multiple skill tokens in one string", () => {
    const out = normalizeCapabilityTokens(
      "@skill:plan then @skill:review",
      "codex",
    );

    expect(out.text).toBe("$plan then $review");
  });

  it("surfaceFormForSkill mirrors the table per adapter", () => {
    expect(surfaceFormForSkill("x", "claude")).toBe("/x");
    expect(surfaceFormForSkill("x", "codex")).toBe("$x");
    expect(surfaceFormForSkill("x", "gemini")).toBe("/x");
  });
});

describe("normalizeCapabilityTokens — subagent expansion + advisory (FR-E2/E5)", () => {
  it("expands @agent:<name> to @name on claude with no warning", () => {
    const out = normalizeCapabilityTokens(
      "ask @agent:reviewer please",
      "claude",
    );

    expect(out.text).toBe("ask @reviewer please");
    expect(out.warnings).toHaveLength(0);
  });

  it("degrades a subagent on codex to the bare name and WARNs (no hard fail, no silent rewrite)", () => {
    const out = normalizeCapabilityTokens(
      "ask @agent:reviewer please",
      "codex",
    );

    expect(out.text).toBe("ask reviewer please");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({
      kind: "subagent",
      slug: "reviewer",
      agent: "codex",
    });
  });

  for (const agent of ADAPTER_IDS.filter((a) => a !== "claude")) {
    it(`warns for a subagent on ${agent} (subagents are claude-only)`, () => {
      const out = normalizeCapabilityTokens("@agent:helper", agent);

      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0].agent).toBe(agent);
    });
  }
});

describe("normalizeCapabilityTokens — verbatim safety (FR-E3/E5)", () => {
  it("leaves plain text with no canonical tokens unchanged (verbatim-forward)", () => {
    const text = "see /usr/bin and $HOME, also email a@b.com — nothing to do";
    const out = normalizeCapabilityTokens(text, "codex");

    expect(out.text).toBe(text);
    expect(out.warnings).toHaveLength(0);
  });

  it("does not touch raw /slug or $slug (only canonical @skill:/@agent: tokens)", () => {
    const out = normalizeCapabilityTokens(
      "run /aif-plan and $review",
      "claude",
    );

    expect(out.text).toBe("run /aif-plan and $review");
  });

  it("ignores a non-slug token after the sigil", () => {
    const out = normalizeCapabilityTokens("@skill: @agent:", "claude");

    expect(out.text).toBe("@skill: @agent:");
  });
});
