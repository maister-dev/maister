import { describe, expect, it } from "vitest";

import { projectAgentSummary } from "@/lib/agents/admin-shared";

describe("projectAgentSummary", () => {
  it("projects a logical package definition path instead of a host source path", () => {
    const summary = projectAgentSummary({
      id: "review-pack:triager",
      packageName: "review-pack",
      versionLabel: "1.0.0",
      origin: "git",
      name: "Triager",
      description: "Triage issues",
      workspace: "repo_read",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      sourcePath: "/private/host-cache/review-pack/maister-agents/triager.md",
      enabled: true,
    });

    expect(summary).toMatchObject({
      definitionPath: "maister-agents/triager.md",
    });
    expect(summary).not.toHaveProperty("sourcePath");
    expect(JSON.stringify(summary)).not.toContain("/private/host-cache");
  });

  it("keeps valid dotted agent stems aligned with their package filename", () => {
    const summary = projectAgentSummary({
      id: "review-pack:triager.v2",
      packageName: "review-pack",
      versionLabel: "1.0.0",
      origin: "git",
      name: "Triager v2",
      description: "Triage issues",
      workspace: "repo_read",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      enabled: true,
    });

    expect(summary).toMatchObject({
      definitionPath: "maister-agents/triager.v2.md",
    });
  });
});
