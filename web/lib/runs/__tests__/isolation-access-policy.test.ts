import { describe, expect, it } from "vitest";

import { resolveIsolationAccess } from "../../../../runtime/isolation-access-policy";

describe("isolation access policy", () => {
  const ceiling = {
    workspace: "repo_read",
    approval: "auto_approve",
    tools: ["read", "search"],
    mcps: ["knowledge"],
  } as const;

  it("inherits omitted allow-lists and preserves an explicit empty grant", () => {
    expect(resolveIsolationAccess(ceiling, { tools: [] }, {})).toEqual({
      allowed: true,
      workspace: { value: "repo_read", layer: "ceiling" },
      approval: { value: "auto_approve", layer: "ceiling" },
      tools: { value: [], layer: "runner" },
      mcps: { value: ["knowledge"], layer: "ceiling" },
    });
  });

  it("refuses a runner request above the ceiling before applying workload constraints", () => {
    expect(
      resolveIsolationAccess(
        ceiling,
        { workspace: "worktree" },
        { workspace: "none" },
      ),
    ).toEqual({
      allowed: false,
      reason: "access_exceeds_ceiling",
      fields: ["workspace"],
    });
    expect(
      resolveIsolationAccess(
        ceiling,
        { tools: ["write"], mcps: ["shell"] },
        {},
      ),
    ).toEqual({
      allowed: false,
      reason: "access_exceeds_ceiling",
      fields: ["tools", "mcps"],
    });
  });

  it("applies the stricter Run permission and intersects tools with workload grants", () => {
    expect(
      resolveIsolationAccess(
        ceiling,
        {},
        { approval: "ask", tools: ["search", "write"] },
      ),
    ).toMatchObject({
      allowed: true,
      approval: { value: "ask", layer: "workload" },
      tools: { value: ["search"], layer: "workload" },
    });
  });
});
