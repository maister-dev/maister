import { describe, expect, it } from "vitest";

import type { SessionEnforcementProfile } from "../types";

import {
  HOOK_RULE_META,
  resolveCapabilityGuardDecision,
} from "../guardrail-hooks";

// ADR-129 T2.2: the pure capability_guard evaluator. Identity is read from
// `title`/`_meta.claudeCode.toolName` (the extractor is unit-tested separately);
// here we assert the allow-list decision + two-strict-class precedence + fail-closed.
const toolsProfile: SessionEnforcementProfile = {
  tools: { allow: ["Read", "Edit", "Bash"] },
  enforcedClasses: ["tools"],
  escalationThreshold: 3,
};

const mcpsProfile: SessionEnforcementProfile = {
  mcps: { allowServers: ["github"] },
  enforcedClasses: ["mcps"],
  escalationThreshold: 3,
};

const bothProfile: SessionEnforcementProfile = {
  tools: { allow: ["Read", "mcp__github__create_issue"] },
  mcps: { allowServers: ["github"] },
  enforcedClasses: ["tools", "mcps"],
  escalationThreshold: 3,
};

describe("resolveCapabilityGuardDecision", () => {
  it("allows an in-profile tool call (tools enforced)", () => {
    expect(
      resolveCapabilityGuardDecision(toolsProfile, { title: "Read" }),
    ).toEqual({ decision: "allow" });
  });

  it("denies an out-of-profile tool call (tools enforced)", () => {
    const decision = resolveCapabilityGuardDecision(toolsProfile, {
      title: "WebFetch",
    });

    expect(decision.decision).toBe("deny");
    expect(decision).toMatchObject({ governedClass: "tools" });
  });

  it("name-matches execute/bash by identity (unlike path_guard)", () => {
    expect(
      resolveCapabilityGuardDecision(toolsProfile, {
        kind: "execute",
        title: "Bash",
      }),
    ).toEqual({ decision: "allow" });
    expect(
      resolveCapabilityGuardDecision(
        { ...toolsProfile, tools: { allow: ["Read"] } },
        { kind: "execute", title: "Bash" },
      ).decision,
    ).toBe("deny");
  });

  it("allows an MCP call to an allowed server (mcps enforced)", () => {
    expect(
      resolveCapabilityGuardDecision(mcpsProfile, {
        title: "mcp__github__create_issue",
      }),
    ).toEqual({ decision: "allow" });
  });

  it("denies an MCP call to a server outside the allow-list (mcps enforced)", () => {
    const decision = resolveCapabilityGuardDecision(mcpsProfile, {
      title: "mcp__gitlab__create_issue",
    });

    expect(decision.decision).toBe("deny");
    expect(decision).toMatchObject({ governedClass: "mcps" });
  });

  it("passes through a non-MCP call when only mcps is enforced (ungoverned)", () => {
    expect(
      resolveCapabilityGuardDecision(mcpsProfile, { title: "Read" }),
    ).toEqual({ decision: "pass_through" });
  });

  it("applies AND-of-allows for a call governed by both tools and mcps", () => {
    // in both allow-lists → allow
    expect(
      resolveCapabilityGuardDecision(bothProfile, {
        title: "mcp__github__create_issue",
      }),
    ).toEqual({ decision: "allow" });

    // tools denies (name not in tools.allow) even though server is allowed
    expect(
      resolveCapabilityGuardDecision(bothProfile, {
        title: "mcp__github__delete_repo",
      }),
    ).toMatchObject({ decision: "deny", governedClass: "tools" });

    // tools allows (name listed) but mcps server denies
    expect(
      resolveCapabilityGuardDecision(
        {
          ...bothProfile,
          tools: { allow: ["mcp__gitlab__create_issue"] },
        },
        { title: "mcp__gitlab__create_issue" },
      ),
    ).toMatchObject({ decision: "deny", governedClass: "mcps" });
  });

  it("fail-closed denies a governed call with no extractable identity (tools enforced)", () => {
    const decision = resolveCapabilityGuardDecision(toolsProfile, {
      kind: "edit",
    });

    expect(decision.decision).toBe("deny");
    expect(decision).toMatchObject({ governedClass: "tools" });
  });

  it("passes through an unidentifiable call when only mcps is enforced", () => {
    expect(
      resolveCapabilityGuardDecision(mcpsProfile, { kind: "edit" }),
    ).toEqual({ decision: "pass_through" });
  });
});

describe("HOOK_RULE_META", () => {
  it("registers capability_guard as a pre_tool_call deny (default disposition)", () => {
    expect(HOOK_RULE_META.capability_guard).toEqual({
      lifecycle: "pre_tool_call",
      disposition: "deny",
    });
  });
});
