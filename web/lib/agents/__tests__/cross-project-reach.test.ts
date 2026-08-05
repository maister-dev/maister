// ADR-156: the reach truth table and the agent-gains-an-op triple.
// One case per `reason` — a deny that resolves to the wrong reason is a
// different bug from a deny that should have been an allow.

import { describe, expect, it } from "vitest";

import { PROJECT_ACTION_BY_SCOPE } from "@/lib/tokens/ext-handler";
import {
  AGENT_TOKEN_SCOPES,
  CROSS_PROJECT_AGENT_SCOPES,
} from "@/types/token-scopes";
import { canAgentReachProject } from "@/lib/agents/cross-project-reach";

type LinkRow = { enabled: boolean; crossProjectReach: boolean };

// Two-table stub: the first select is the link lookup, the second the run depth.
function stubDb(opts: { link?: LinkRow; depth?: number }) {
  let call = 0;

  return {
    select: () => ({
      from: () => ({
        where: () => {
          call += 1;
          if (call === 1) return opts.link ? [opts.link] : [];

          return opts.depth === undefined ? [] : [{ depth: opts.depth }];
        },
      }),
    }),
  };
}

const BASE = {
  agentId: "pkg:worker",
  targetProjectId: "proj-b",
  scopeLabel: "tasks:read",
  callingRunId: "run-1",
};

describe("canAgentReachProject truth table (ADR-156)", () => {
  it("allows a subset scope with an enabled reach-granted link and budget left", async () => {
    await expect(
      canAgentReachProject({
        ...BASE,
        db: stubDb({
          link: { enabled: true, crossProjectReach: true },
          depth: 0,
        }) as never,
      }),
    ).resolves.toEqual({ allowed: true, reason: "ok" });
  });

  it("denies scope_not_in_subset BEFORE looking at any link", async () => {
    await expect(
      canAgentReachProject({
        ...BASE,
        scopeLabel: "tasks:update",
        db: {
          select: () => {
            throw new Error("must not query for an out-of-subset scope");
          },
        } as never,
      }),
    ).resolves.toEqual({ allowed: false, reason: "scope_not_in_subset" });
  });

  it("denies no_link when the agent is not attached to the target", async () => {
    await expect(
      canAgentReachProject({ ...BASE, db: stubDb({}) as never }),
    ).resolves.toEqual({ allowed: false, reason: "no_link" });
  });

  it("denies link_disabled for an attached-but-disabled link", async () => {
    await expect(
      canAgentReachProject({
        ...BASE,
        db: stubDb({
          link: { enabled: false, crossProjectReach: true },
        }) as never,
      }),
    ).resolves.toEqual({ allowed: false, reason: "link_disabled" });
  });

  it("denies reach_off when the grant was never given — deny by default", async () => {
    await expect(
      canAgentReachProject({
        ...BASE,
        db: stubDb({
          link: { enabled: true, crossProjectReach: false },
        }) as never,
      }),
    ).resolves.toEqual({ allowed: false, reason: "reach_off" });
  });

  it("denies chain_depth_exhausted at the cap", async () => {
    await expect(
      canAgentReachProject({
        ...BASE,
        db: stubDb({
          link: { enabled: true, crossProjectReach: true },
          depth: 2,
        }) as never,
      }),
    ).resolves.toEqual({ allowed: false, reason: "chain_depth_exhausted" });
  });

  it("fails CLOSED when the reach cannot be attributed to a run", async () => {
    await expect(
      canAgentReachProject({
        ...BASE,
        callingRunId: null,
        db: stubDb({
          link: { enabled: true, crossProjectReach: true },
        }) as never,
      }),
    ).resolves.toEqual({ allowed: false, reason: "chain_depth_exhausted" });
  });
});

describe("cross-project scope subset guards (ADR-156)", () => {
  // projectActionForScope ends in `?? "readBoard"`, so an unmapped WRITE scope
  // silently resolves to the viewer-level action — a privilege hole that no
  // route test would catch.
  it("every CROSS_PROJECT_AGENT_SCOPES member has a PROJECT_ACTION_BY_SCOPE entry", () => {
    const unmapped = CROSS_PROJECT_AGENT_SCOPES.filter(
      (scope) => PROJECT_ACTION_BY_SCOPE[scope] === undefined,
    );

    expect(unmapped).toEqual([]);
  });

  it("the subset is a strict subset of AGENT_TOKEN_SCOPES", () => {
    const outside = CROSS_PROJECT_AGENT_SCOPES.filter(
      (scope) => !(AGENT_TOKEN_SCOPES as readonly string[]).includes(scope),
    );

    expect(outside).toEqual([]);
  });

  it("excludes every deliberately-withheld scope", () => {
    for (const withheld of [
      "tasks:update",
      "tasks:triage",
      "hitl:request",
      "flows:read",
      "runners:read",
      "memory:read",
      "memory:write",
      "agent_memory:write",
    ]) {
      expect(CROSS_PROJECT_AGENT_SCOPES as readonly string[]).not.toContain(
        withheld,
      );
    }
  });

  // The agent-gains-an-op triple: route scopeLabel + scope→action map + grant
  // list must move together. The grant list is the one that gets forgotten.
  it("tasks:create is granted to agents AND maps to createTask", () => {
    expect(AGENT_TOKEN_SCOPES as readonly string[]).toContain("tasks:create");
    expect(PROJECT_ACTION_BY_SCOPE["tasks:create"]).toBe("createTask");
  });
});
