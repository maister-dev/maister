import { describe, expect, it } from "vitest";

import { isMaisterError } from "@/lib/errors";
import {
  deriveSessionEnforcementProfile,
  foldEnforcementProfileIntoDigest,
  resolveEscalationThreshold,
} from "@/lib/flows/enforcement-profile";

// ADR-129 T3.1: derive the SessionEnforcementProfile (allow-list, DES-7) + the
// profileDigest fold (mid-session drift guard).

function toolsStrict(agent = "claude") {
  return {
    tools: { [agent]: ["Read", "Edit"] },
    enforcement: { tools: "strict" as const },
  };
}

describe("deriveSessionEnforcementProfile", () => {
  it("derives a tools allow-list from settings.tools[agent] when tools is strict", () => {
    const profile = deriveSessionEnforcementProfile({
      settings: toolsStrict("claude"),
      agent: "claude",
      mcpServerNames: [],
      escalationThreshold: 3,
    });

    expect(profile).toEqual({
      tools: { allow: ["Read", "Edit"] },
      enforcedClasses: ["tools"],
      escalationThreshold: 3,
    });
  });

  it("derives an mcps allow-list from the resolved server names when mcps is strict", () => {
    const profile = deriveSessionEnforcementProfile({
      settings: { mcps: ["github-ref"], enforcement: { mcps: "strict" } },
      agent: "claude",
      mcpServerNames: ["github", "maister"],
      escalationThreshold: 3,
    });

    expect(profile).toEqual({
      mcps: { allowServers: ["github", "maister"] },
      enforcedClasses: ["mcps"],
      escalationThreshold: 3,
    });
  });

  it("derives BOTH classes when tools and mcps are strict", () => {
    const profile = deriveSessionEnforcementProfile({
      settings: {
        tools: { claude: ["Bash"] },
        mcps: ["x"],
        enforcement: { tools: "strict", mcps: "strict" },
      },
      agent: "claude",
      mcpServerNames: ["github"],
      escalationThreshold: 3,
    });

    expect(profile?.enforcedClasses).toEqual(["tools", "mcps"]);
    expect(profile?.tools).toEqual({ allow: ["Bash"] });
    expect(profile?.mcps).toEqual({ allowServers: ["github"] });
  });

  it("refuses CONFIG when tools is strict but the resolved agent has no declared allow-set", () => {
    let err: unknown;

    try {
      deriveSessionEnforcementProfile({
        settings: { tools: { codex: ["Bash"] }, enforcement: { tools: "strict" } },
        agent: "claude", // claude has no tools entry
        mcpServerNames: [],
        escalationThreshold: 3,
      });
    } catch (e) {
      err = e;
    }

    expect(isMaisterError(err) && err.code).toBe("CONFIG");
  });

  it("returns undefined when no class is declared strict", () => {
    expect(
      deriveSessionEnforcementProfile({
        settings: {
          tools: { claude: ["Read"] },
          enforcement: { tools: "instruct" },
        },
        agent: "claude",
        mcpServerNames: [],
        escalationThreshold: 3,
      }),
    ).toBeUndefined();
  });

  it("is deterministic across attempts (D4: a resume re-derives the identical profile from pinned inputs)", () => {
    const args = {
      settings: {
        tools: { claude: ["Bash"] },
        mcps: ["x"],
        enforcement: { tools: "strict" as const, mcps: "strict" as const },
      },
      agent: "claude" as const,
      mcpServerNames: ["github"],
      escalationThreshold: 3,
    };

    // Fresh attempt vs a resumed attempt re-deriving from the same pinned settings +
    // resolved revisions + (stable) table produce byte-identical results — so the
    // write-once launch-time snapshot the resume reads never drifts.
    expect(deriveSessionEnforcementProfile(args)).toEqual(
      deriveSessionEnforcementProfile(args),
    );
  });

  it("still derives for an enforceable adapter that lacks smoke evidence (the GATE refuses, not derivation)", () => {
    // gemini's table cells are `enforced` (adapter-agnostic); the evidence gate
    // refuses it at launch, but derivation itself must succeed.
    const profile = deriveSessionEnforcementProfile({
      settings: toolsStrict("gemini"),
      agent: "gemini",
      mcpServerNames: [],
      escalationThreshold: 3,
    });

    expect(profile?.tools).toEqual({ allow: ["Read", "Edit"] });
  });
});

describe("resolveEscalationThreshold", () => {
  it("defaults to 3", () => {
    expect(resolveEscalationThreshold({})).toBe(3);
  });

  it("reads MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD", () => {
    expect(
      resolveEscalationThreshold({
        MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD: "5",
      }),
    ).toBe(5);
  });

  it("falls back to 3 on a non-positive or malformed value", () => {
    expect(
      resolveEscalationThreshold({
        MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD: "0",
      }),
    ).toBe(3);
    expect(
      resolveEscalationThreshold({
        MAISTER_CAPABILITY_DENY_ESCALATION_THRESHOLD: "nope",
      }),
    ).toBe(3);
  });
});

describe("foldEnforcementProfileIntoDigest", () => {
  const base = "base-digest";

  it("leaves the base digest unchanged when there is no enforcement profile", () => {
    expect(foldEnforcementProfileIntoDigest(base, undefined)).toBe(base);
  });

  it("changes the digest when an enforcement profile is present", () => {
    const withProfile = foldEnforcementProfileIntoDigest(base, {
      tools: { allow: ["Read"] },
      enforcedClasses: ["tools"],
      escalationThreshold: 3,
    });

    expect(withProfile).not.toBe(base);
  });

  it("changes when the allow-set changes, stable when it does not", () => {
    const a = foldEnforcementProfileIntoDigest(base, {
      tools: { allow: ["Read"] },
      enforcedClasses: ["tools"],
      escalationThreshold: 3,
    });
    const aAgain = foldEnforcementProfileIntoDigest(base, {
      tools: { allow: ["Read"] },
      enforcedClasses: ["tools"],
      escalationThreshold: 3,
    });
    const b = foldEnforcementProfileIntoDigest(base, {
      tools: { allow: ["Read", "Edit"] },
      enforcedClasses: ["tools"],
      escalationThreshold: 3,
    });

    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
  });
});
