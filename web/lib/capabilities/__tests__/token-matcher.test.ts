import { describe, expect, it } from "vitest";

import {
  type MatchCatalogEntry,
  matchCapabilityTokens,
} from "@/lib/capabilities/token-matcher";
import { normalizeCapabilityTokens } from "@/lib/capabilities/token-normalizer";

const catalog: MatchCatalogEntry[] = [
  { kind: "skill", slug: "aif-plan" },
  { kind: "skill", slug: "review" },
  { kind: "subagent", slug: "reviewer" },
];

describe("matchCapabilityTokens — exact catalog promotion (FR-E3)", () => {
  it("promotes /slug to a canonical skill ref", () => {
    const out = matchCapabilityTokens("run /aif-plan first", catalog);

    expect(out.text).toBe("run @skill:aif-plan first");
    expect(out.promoted).toHaveLength(1);
    expect(out.promoted[0]).toMatchObject({ kind: "skill", slug: "aif-plan" });
  });

  it("promotes $slug to the SAME canonical skill ref (sigil-agnostic)", () => {
    const out = matchCapabilityTokens("run $aif-plan first", catalog);

    expect(out.text).toBe("run @skill:aif-plan first");
  });

  it("promotes both sigils for the same slug to the same ref", () => {
    const out = matchCapabilityTokens("/review and $review", catalog);

    expect(out.text).toBe("@skill:review and @skill:review");
    expect(out.promoted).toHaveLength(2);
  });

  it("promotes @name to a canonical subagent ref", () => {
    const out = matchCapabilityTokens("ping @reviewer ok", catalog);

    expect(out.text).toBe("ping @agent:reviewer ok");
    expect(out.promoted[0]).toMatchObject({
      kind: "subagent",
      slug: "reviewer",
    });
  });

  it("matches a parenthesized token", () => {
    const out = matchCapabilityTokens("(/aif-plan)", catalog);

    expect(out.text).toBe("(@skill:aif-plan)");
  });

  it("strips a trailing sentence period from the boundary", () => {
    const out = matchCapabilityTokens("use /aif-plan.", catalog);

    expect(out.text).toBe("use @skill:aif-plan.");
  });
});

describe("matchCapabilityTokens — never over-promote (FR-E3)", () => {
  it("never promotes a filesystem path like /usr/bin", () => {
    const out = matchCapabilityTokens("look in /usr/bin please", catalog);

    expect(out.text).toBe("look in /usr/bin please");
    expect(out.promoted).toHaveLength(0);
  });

  it("never promotes shell vars like $HOME or $PATH", () => {
    const out = matchCapabilityTokens("echo $HOME and $PATH", catalog);

    expect(out.text).toBe("echo $HOME and $PATH");
    expect(out.promoted).toHaveLength(0);
  });

  it("leaves an unknown /slug literal", () => {
    const out = matchCapabilityTokens("run /not-a-real-skill", catalog);

    expect(out.text).toBe("run /not-a-real-skill");
    expect(out.promoted).toHaveLength(0);
  });

  it("does not promote a token without a leading boundary (path segment)", () => {
    const out = matchCapabilityTokens("foo/aif-plan", catalog);

    expect(out.text).toBe("foo/aif-plan");
  });

  it("does not treat @name as a skill (sigil binds to kind)", () => {
    const out = matchCapabilityTokens("@aif-plan", catalog);

    // aif-plan is a skill, not a subagent — @ binds to subagent kind only
    expect(out.text).toBe("@aif-plan");
    expect(out.promoted).toHaveLength(0);
  });
});

describe("matchCapabilityTokens — code-span suppression (FR-E3)", () => {
  it("suppresses a token inside an inline code span", () => {
    const out = matchCapabilityTokens("use `/aif-plan` here", catalog);

    expect(out.text).toBe("use `/aif-plan` here");
    expect(out.promoted).toHaveLength(0);
  });

  it("suppresses tokens inside a fenced code block", () => {
    const src = "before\n```\n/aif-plan\n$review\n```\nafter /review";
    const out = matchCapabilityTokens(src, catalog);

    // Only the /review OUTSIDE the fence is promoted.
    expect(out.text).toBe(
      "before\n```\n/aif-plan\n$review\n```\nafter @skill:review",
    );
    expect(out.promoted).toHaveLength(1);
  });
});

describe("send-time backstop — match then normalize (FR-E4 acceptance)", () => {
  it("pasted /aif-plan runs correctly on codex (→ $aif-plan)", () => {
    const matched = matchCapabilityTokens("please /aif-plan now", catalog);
    const normalized = normalizeCapabilityTokens(matched.text, "codex");

    expect(normalized.text).toBe("please $aif-plan now");
  });

  it("pasted /aif-plan stays /aif-plan on claude", () => {
    const matched = matchCapabilityTokens("please /aif-plan now", catalog);
    const normalized = normalizeCapabilityTokens(matched.text, "claude");

    expect(normalized.text).toBe("please /aif-plan now");
  });
});
