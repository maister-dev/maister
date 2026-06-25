// Phase 5 / T5.1 (ADR-112): the core-package Triager agent definition is
// CONTENT (a maister-agents/triager.md shipped in maister-plugins). Its
// acceptance is that the real parser accepts it and yields the declared shape:
// the 3 config params, risk_tier=read_only, workspace=none, no flow, and the
// domain_event + manual triggers. The maister-repo fixture under
// fixtures/core-package/ is byte-identical to the maister-plugins deliverable,
// so this test does not depend on the sibling repo being present.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseAgentDefinition } from "@/lib/agents/definition";

const TRIAGER_MD = readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "core-package",
    "maister-agents",
    "triager.md",
  ),
  "utf8",
);

describe("core:triager definition (T5.1)", () => {
  it("parses into the declared platform-agent shape", () => {
    const parsed = parseAgentDefinition("core:triager", TRIAGER_MD);

    expect(parsed).toMatchObject({
      id: "core:triager",
      name: "Triager",
      workspace: "none",
      mode: "session",
      riskTier: "read_only",
      // No same-package flow: it runs as a standalone agent session.
      flow: null,
    });
    expect(parsed.triggers).toEqual(["domain_event", "manual"]);
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(parsed.prompt.trim().length).toBeGreaterThan(0);
  });

  it("declares the three triager config params with defaults", () => {
    const parsed = parseAgentDefinition("core:triager", TRIAGER_MD);

    expect(parsed.config).not.toBeNull();
    const byKey = new Map((parsed.config ?? []).map((p) => [p.key, p]));

    expect([...byKey.keys()].sort()).toEqual([
      "auto_enqueue",
      "detect_duplicates",
      "intake_mode",
    ]);

    // auto_enqueue: enum off|when_confident|always, default off (quoted so YAML
    // does not coerce `off` to the boolean false).
    expect(byKey.get("auto_enqueue")).toMatchObject({
      type: "enum",
      values: ["off", "when_confident", "always"],
      default: "off",
    });
    expect(byKey.get("detect_duplicates")).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(byKey.get("intake_mode")).toMatchObject({
      type: "enum",
      values: ["triage_only", "clarify"],
      default: "clarify",
    });
  });

  it("recommends the three triage event bindings", () => {
    const parsed = parseAgentDefinition("core:triager", TRIAGER_MD);

    expect(parsed.recommended?.events).toEqual([
      "task.created",
      "task.triage_requeued",
      "task.comment_added",
    ]);
  });
});
