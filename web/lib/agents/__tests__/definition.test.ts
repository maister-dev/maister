import { describe, expect, it } from "vitest";

import {
  parseAgentDefinition,
  renderAgentDefinition,
} from "@/lib/agents/definition";
import { isMaisterError } from "@/lib/errors";

const VALID = `---
name: Triager
description: Classifies new tasks
scope: platform
runner: claude-default
workspace: repo_read
mode: session
triggers:
  - manual
  - domain_event
capability_profile:
  mcp_servers: []
risk_tier: read_only
---
You are the triager. Classify the task.
`;

function expectConfig(fn: () => unknown, match: RegExp): void {
  try {
    fn();
    expect.unreachable("expected CONFIG");
  } catch (err) {
    expect(isMaisterError(err)).toBe(true);
    if (isMaisterError(err)) {
      expect(err.code).toBe("CONFIG");
      expect(err.message).toMatch(match);
    }
  }
}

describe("parseAgentDefinition", () => {
  it("parses a valid definition into the typed shape", () => {
    const parsed = parseAgentDefinition("triager", VALID);

    expect(parsed).toMatchObject({
      id: "triager",
      name: "Triager",
      scope: "platform",
      projectSlug: null,
      runner: "claude-default",
      workspace: "repo_read",
      mode: "session",
      triggers: ["manual", "domain_event"],
      riskTier: "read_only",
    });
    expect(parsed.prompt).toContain("You are the triager.");
  });

  it("refuses unknown frontmatter keys (strict schema)", () => {
    const content = VALID.replace(
      "risk_tier: read_only",
      "risk_tier: read_only\nbogus_key: 1",
    );

    expectConfig(
      () => parseAgentDefinition("triager", content),
      /bogus_key|unrecognized/i,
    );
  });

  it("refuses missing required fields", () => {
    expectConfig(
      () => parseAgentDefinition("triager", "---\nname: X\n---\nbody\n"),
      /description/,
    );
  });

  it("refuses a bad enum value", () => {
    expectConfig(
      () =>
        parseAgentDefinition(
          "triager",
          VALID.replace("workspace: repo_read", "workspace: read_write"),
        ),
      /workspace/,
    );
  });

  it("requires `project` exactly for scope=project", () => {
    expectConfig(
      () =>
        parseAgentDefinition(
          "triager",
          VALID.replace("scope: platform", "scope: project"),
        ),
      /project/,
    );
    expectConfig(
      () =>
        parseAgentDefinition(
          "triager",
          VALID.replace("scope: platform", "scope: platform\nproject: myapp"),
        ),
      /project/,
    );
  });

  it("refuses standalone triggers on mode=subagent", () => {
    expectConfig(
      () =>
        parseAgentDefinition(
          "triager",
          VALID.replace("mode: session", "mode: subagent"),
        ),
      /subagent allows only the `flow` trigger/,
    );

    const flowOnly = VALID.replace("mode: session", "mode: subagent").replace(
      "triggers:\n  - manual\n  - domain_event",
      "triggers:\n  - flow",
    );

    expect(parseAgentDefinition("triager", flowOnly).mode).toBe("subagent");
  });

  it("refuses missing frontmatter, malformed yaml, and an empty body", () => {
    expectConfig(
      () => parseAgentDefinition("triager", "just a body\n"),
      /missing frontmatter/,
    );
    expectConfig(
      () => parseAgentDefinition("triager", "---\nname: [unterminated\n"),
      /malformed frontmatter/,
    );
    expectConfig(
      () =>
        parseAgentDefinition(
          "triager",
          VALID.split("---")[0] +
            "---\n" +
            VALID.split("---")[1] +
            "---\n   \n",
        ),
      /body prompt must not be empty/,
    );
  });

  it("refuses an unsafe agent id", () => {
    expectConfig(() => parseAgentDefinition("../evil", VALID), /agent id/);
  });
});

describe("renderAgentDefinition", () => {
  it("round-trips: render → parse yields the same shape", () => {
    const rendered = renderAgentDefinition({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews diffs",
      scope: "project",
      project: "myapp",
      runner: null,
      workspace: "worktree",
      mode: "session",
      triggers: ["manual", "flow"],
      capabilityProfile: { skills: ["review"] },
      riskTier: "standard",
      prompt: "Review the diff.",
    });

    const parsed = parseAgentDefinition("reviewer", rendered);

    expect(parsed).toMatchObject({
      name: "Reviewer",
      scope: "project",
      projectSlug: "myapp",
      runner: null,
      workspace: "worktree",
      triggers: ["manual", "flow"],
      capabilityProfile: { skills: ["review"] },
      riskTier: "standard",
    });
  });

  it("omitted optional fields stay absent (CLEAR-able on re-render)", () => {
    const rendered = renderAgentDefinition({
      id: "minimal",
      name: "Minimal",
      description: "d",
      scope: "platform",
      workspace: "none",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      prompt: "p",
    });

    expect(rendered).not.toContain("runner:");
    expect(rendered).not.toContain("capability_profile:");
    expect(rendered).not.toContain("project:");
  });
});
