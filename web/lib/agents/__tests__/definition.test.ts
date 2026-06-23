import { describe, expect, it } from "vitest";

import {
  parseAgentDefinition,
  qualifyAgentId,
  renderAgentDefinition,
} from "@/lib/agents/definition";
import { isMaisterError } from "@/lib/errors-core";

const VALID = `---
name: Triager
description: Classifies new tasks
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
  it("parses a valid definition into the typed shape (qualified id)", () => {
    const parsed = parseAgentDefinition("aif:triager", VALID);

    expect(parsed).toMatchObject({
      id: "aif:triager",
      name: "Triager",
      runner: "claude-default",
      workspace: "repo_read",
      workspaceRef: null,
      mode: "session",
      triggers: ["manual", "domain_event"],
      riskTier: "read_only",
      recommended: null,
    });
    expect(parsed.prompt).toContain("You are the triager.");
  });

  it("defaults hooks to null when absent", () => {
    expect(parseAgentDefinition("aif:triager", VALID).hooks).toBeNull();
  });

  it("parses an explicit hooks block (ADR-104, explicit agent arming)", () => {
    const withHooks = VALID.replace(
      "risk_tier: read_only",
      'risk_tier: read_only\nhooks:\n  repetition:\n    max: 5\n  pathGuard:\n    allowedPaths:\n      - "src/**"',
    );
    const parsed = parseAgentDefinition("aif:triager", withHooks);

    expect(parsed.hooks).toEqual({
      repetition: { max: 5 },
      pathGuard: { allowedPaths: ["src/**"] },
    });
  });

  it("refuses an invalid hooks block (non-positive cap)", () => {
    const bad = VALID.replace(
      "risk_tier: read_only",
      "risk_tier: read_only\nhooks:\n  repetition:\n    max: -1",
    );

    expectConfig(() => parseAgentDefinition("aif:triager", bad), /hooks|max/);
  });

  it("refuses unknown frontmatter keys (strict schema)", () => {
    const content = VALID.replace(
      "risk_tier: read_only",
      "risk_tier: read_only\nbogus_key: 1",
    );

    expectConfig(
      () => parseAgentDefinition("aif:triager", content),
      /bogus_key|unrecognized/i,
    );
  });

  it("refuses the dead pre-rework scope/project keys loudly", () => {
    expectConfig(
      () =>
        parseAgentDefinition(
          "aif:triager",
          VALID.replace("runner: claude-default", "scope: platform"),
        ),
      /scope|unrecognized/i,
    );
    expectConfig(
      () =>
        parseAgentDefinition(
          "aif:triager",
          VALID.replace("runner: claude-default", "project: myapp"),
        ),
      /project|unrecognized/i,
    );
  });

  it("refuses missing required fields", () => {
    expectConfig(
      () => parseAgentDefinition("aif:triager", "---\nname: X\n---\nbody\n"),
      /description/,
    );
  });

  it("refuses a bad enum value", () => {
    expectConfig(
      () =>
        parseAgentDefinition(
          "aif:triager",
          VALID.replace("workspace: repo_read", "workspace: read_write"),
        ),
      /workspace/,
    );
  });

  it("refuses standalone triggers on mode=subagent", () => {
    expectConfig(
      () =>
        parseAgentDefinition(
          "aif:triager",
          VALID.replace("mode: session", "mode: subagent"),
        ),
      /subagent allows only the `flow` trigger/,
    );

    const flowOnly = VALID.replace("mode: session", "mode: subagent").replace(
      "triggers:\n  - manual\n  - domain_event",
      "triggers:\n  - flow",
    );

    expect(parseAgentDefinition("aif:triager", flowOnly).mode).toBe("subagent");
  });

  it("accepts workspace_ref only with workspace=repo_read", () => {
    const withRef = VALID.replace(
      "workspace: repo_read",
      "workspace: repo_read\nworkspace_ref: trigger",
    );

    expect(parseAgentDefinition("aif:triager", withRef).workspaceRef).toBe(
      "trigger",
    );

    expectConfig(
      () =>
        parseAgentDefinition(
          "aif:triager",
          VALID.replace(
            "workspace: repo_read",
            "workspace: none\nworkspace_ref: trigger",
          ),
        ),
      /workspace_ref is only valid with workspace=repo_read/,
    );
  });

  it("parses the recommended block and refuses unknown event kinds", () => {
    const withRecommended = VALID.replace(
      "risk_tier: read_only",
      [
        "risk_tier: read_only",
        "recommended:",
        "  runner: claude-default",
        "  cron:",
        '    expr: "*/30 * * * *"',
        "    timezone: UTC",
        "  events:",
        "    - run.failed",
        "    - gate.failed",
      ].join("\n"),
    );
    const parsed = parseAgentDefinition("aif:triager", withRecommended);

    expect(parsed.recommended).toEqual({
      runner: "claude-default",
      cron: { expr: "*/30 * * * *", timezone: "UTC" },
      events: ["run.failed", "gate.failed"],
    });

    expectConfig(
      () =>
        parseAgentDefinition(
          "aif:triager",
          VALID.replace(
            "risk_tier: read_only",
            "risk_tier: read_only\nrecommended:\n  events:\n    - not.a.kind",
          ),
        ),
      /events/,
    );
  });

  it("refuses missing frontmatter, malformed yaml, and an empty body", () => {
    expectConfig(
      () => parseAgentDefinition("aif:triager", "just a body\n"),
      /missing frontmatter/,
    );
    expectConfig(
      () => parseAgentDefinition("aif:triager", "---\nname: [unterminated\n"),
      /malformed frontmatter/,
    );
    expectConfig(
      () =>
        parseAgentDefinition(
          "aif:triager",
          VALID.split("---")[0] +
            "---\n" +
            VALID.split("---")[1] +
            "---\n   \n",
        ),
      /body prompt must not be empty/,
    );
  });

  it("refuses an unsafe agent id (two colons, dot-dot, bad chars)", () => {
    expectConfig(() => parseAgentDefinition("../evil", VALID), /agent id/);
    expectConfig(() => parseAgentDefinition("a:b:c", VALID), /agent id/);
    expectConfig(() => parseAgentDefinition("aif:..", VALID), /agent id/);
  });
});

describe("qualifyAgentId", () => {
  it("composes <flowRefId>:<stem> and refuses unsafe stems", () => {
    expect(qualifyAgentId("aif", "triager")).toBe("aif:triager");
    expect(() => qualifyAgentId("aif", "..")).toThrow(/stem/);
    expect(() => qualifyAgentId("aif", "a:b")).toThrow(/stem/);
  });
});

describe("renderAgentDefinition", () => {
  it("round-trips: render → parse yields the same shape", () => {
    const rendered = renderAgentDefinition({
      id: "aif:reviewer",
      name: "Reviewer",
      description: "Reviews diffs",
      runner: null,
      workspace: "worktree",
      mode: "session",
      triggers: ["manual", "flow"],
      capabilityProfile: { skills: ["review"] },
      riskTier: "standard",
      recommended: { events: ["run.done"] },
      prompt: "Review the diff.",
    });

    const parsed = parseAgentDefinition("aif:reviewer", rendered);

    expect(parsed).toMatchObject({
      name: "Reviewer",
      runner: null,
      workspace: "worktree",
      triggers: ["manual", "flow"],
      capabilityProfile: { skills: ["review"] },
      riskTier: "standard",
      recommended: { events: ["run.done"] },
    });
  });

  it("omitted optional fields stay absent (CLEAR-able on re-render)", () => {
    const rendered = renderAgentDefinition({
      id: "aif:minimal",
      name: "Minimal",
      description: "d",
      workspace: "none",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      prompt: "p",
    });

    expect(rendered).not.toContain("runner:");
    expect(rendered).not.toContain("capability_profile:");
    expect(rendered).not.toContain("recommended:");
    expect(rendered).not.toContain("workspace_ref:");
  });
});
