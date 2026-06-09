// M27/T-A3 (RED): render tests for the per-gate side-form. renderToStaticMarkup
// (no jsdom) — asserts that each gate kind surfaces its kind-specific fields +
// the mode selector. Interaction (onChange) is the editor e2e's job (T-A9).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GateForm } from "@/components/flows/node-form/gate-form";

type GateFormProps = Parameters<typeof GateForm>[0];

const labels: GateFormProps["labels"] = {
  mode: "Mode",
  modeBlocking: "Blocking",
  modeAdvisory: "Advisory",
  command: "Command",
  prompt: "Prompt",
  skill: "Skill",
  confidenceMin: "Min confidence",
  externalDescription: "External description",
  staleOnNewCommit: "Stale on new commit",
  remove: "Remove gate",
  kind: {
    command_check: "Command check",
    skill_check: "Skill check",
    ai_judgment: "AI judgment",
    artifact_required: "Artifact required",
    external_check: "External check",
    human_review: "Human review",
  },
};

function render(gate: GateFormProps["gate"]): string {
  return renderToStaticMarkup(
    createElement(GateForm, {
      gate,
      labels,
      onChange: () => {},
      onRemove: () => {},
    }),
  );
}

describe("GateForm — common chrome", () => {
  it("renders the gate id, kind label, mode selector and remove control", () => {
    const html = render({ id: "g1", kind: "command_check", mode: "blocking" });

    expect(html).toContain('data-testid="gate-form-g1"');
    expect(html).toContain("Command check");
    expect(html).toContain('data-testid="gate-mode"');
    expect(html).toContain('data-testid="gate-remove"');
  });
});

describe("GateForm — kind-specific fields", () => {
  it("command_check renders the command field", () => {
    const html = render({ id: "g1", kind: "command_check" });

    expect(html).toContain('data-testid="gate-command"');
  });

  it("external_check renders the command field + external sub-fields", () => {
    const html = render({ id: "g1", kind: "external_check" });

    expect(html).toContain('data-testid="gate-command"');
    expect(html).toContain('data-testid="gate-stale-on-new-commit"');
    expect(html).toContain('data-testid="gate-external-description"');
  });

  it("skill_check renders the skill field", () => {
    const html = render({ id: "g1", kind: "skill_check" });

    expect(html).toContain('data-testid="gate-skill"');
  });

  it("ai_judgment renders the prompt field + calibration confidence", () => {
    const html = render({ id: "g1", kind: "ai_judgment" });

    expect(html).toContain('data-testid="gate-prompt"');
    expect(html).toContain('data-testid="gate-confidence-min"');
  });

  it("skill_check renders calibration confidence (allowed kind)", () => {
    const html = render({ id: "g1", kind: "skill_check" });

    expect(html).toContain('data-testid="gate-confidence-min"');
  });

  it("command_check does NOT render calibration (disallowed kind)", () => {
    const html = render({ id: "g1", kind: "command_check" });

    expect(html).not.toContain('data-testid="gate-confidence-min"');
  });

  it("human_review renders neither command/skill/prompt nor calibration", () => {
    const html = render({ id: "g1", kind: "human_review", mode: "advisory" });

    expect(html).not.toContain('data-testid="gate-command"');
    expect(html).not.toContain('data-testid="gate-skill"');
    expect(html).not.toContain('data-testid="gate-confidence-min"');
  });
});
