// M27/T-A3 (RED): render tests for the node side-form. renderToStaticMarkup
// (no jsdom) asserts that each node type surfaces its action + type-specific
// settings + the common rework/output sections, and that gates render a
// GateForm each. onChange wiring is the editor e2e's job (T-A9).

import type { FlowYamlV1 } from "@/lib/config.schema";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NodeSideForm } from "@/components/flows/node-form/node-side-form";
import { flowYamlV1Schema } from "@/lib/config.schema";

type NodeSideFormProps = Parameters<typeof NodeSideForm>[0];
type NodeDef = NonNullable<FlowYamlV1["nodes"]>[number];

const MANIFEST: FlowYamlV1 = flowYamlV1Schema.parse({
  schemaVersion: 1,
  name: "t",
  nodes: [
    {
      id: "plan",
      type: "ai_coding",
      action: { prompt: "do plan" },
      transitions: { approve: "build" },
      settings: {
        model: "claude-sonnet-4-6",
        thinkingEffort: "high",
        permissionMode: "ask",
        workspaceAccess: "write",
        hooks: {
          repetition: { max: 5 },
          noProgress: { maxTurns: 15 },
          pathGuard: { allowedPaths: ["src/**", "lib/**"] },
        },
      },
      rework: {
        allowedTargets: ["plan"],
        workspacePolicies: ["keep"],
        maxLoops: 2,
      },
      output: { result: { schema: "./s.json", required: true } },
      pre_finish: { gates: [{ id: "g1", kind: "command_check" }] },
    },
    {
      id: "build",
      type: "cli",
      action: { command: "make" },
      settings: {
        timeoutMs: 1000,
        environmentPolicy: "clean",
        failureClass: "blocking",
      },
    },
    {
      id: "assess",
      type: "judge",
      action: { prompt: "judge it" },
      settings: { model: "m", thinkingEffort: "low" },
    },
    {
      id: "review",
      type: "human",
      settings: { decisions: ["approve", "reject"], criticality: "high" },
    },
    {
      id: "triage",
      type: "judge",
      action: { prompt: "judge it" },
      transitions: { approve: "build", review: "review" },
      decide: {
        from: "verdict",
        cases: [
          { when: "confidence >= 0.8", target: "approve" },
          { default: true, target: "review" },
        ],
      },
    },
    {
      id: "classify",
      type: "ai_coding",
      action: { prompt: "classify" },
      transitions: { bug: "build", feature: "build" },
      output: { result: { schema: "./s.json", on_mismatch: "retry" } },
      rework: {
        allowedTargets: ["build"],
        workspacePolicies: ["keep"],
        maxLoops: 2,
      },
      decide: { from: "output.triage.outcome" },
    },
  ],
});

function nodeById(id: string): NodeDef {
  const node = MANIFEST.nodes?.find((n) => n.id === id);

  if (!node) throw new Error(`fixture missing node ${id}`);

  return node;
}

const labels: NodeSideFormProps["labels"] = {
  empty: "Select a node",
  action: "Action",
  settings: "Settings",
  gates: "Gates",
  transitions: "Transitions",
  rework: "Rework",
  output: "Structured output",
  prompt: "Prompt",
  command: "Command",
  model: "Model",
  thinkingEffort: "Thinking effort",
  permissionMode: "Permission mode",
  workspaceAccess: "Workspace access",
  skills: "Skills",
  restrictions: "Restrictions",
  mcps: "Additional MCPs",
  enforcement: {
    title: "Enforcement",
    mcps: "MCPs",
    tools: "Tools",
    skills: "Skills",
    restrictions: "Restrictions",
    permissionMode: "Permission mode",
    workspaceAccess: "Workspace access",
    hooks: "Guardrail hooks",
  },
  timeoutMs: "Timeout (ms)",
  environmentPolicy: "Environment policy",
  failureClass: "Failure class",
  decisions: "Decisions",
  criticality: "Criticality",
  roles: "Roles",
  assignees: "Assignees",
  allowTakeover: "Allow takeover",
  outputSchema: "Result schema",
  outputRequired: "Required",
  presentation: "Appearance",
  presentationWidth: "Width (px)",
  presentationHeight: "Height (px)",
  presentationColor: "Color",
  reworkAllowedTargets: "Allowed targets",
  reworkWorkspacePolicies: "Workspace policies",
  reworkMaxLoops: "Max loops",
  reworkCommentsVar: "Comments var",
  transitionOutcome: "Outcome",
  transitionTarget: "Target",
  addTransition: "Add transition",
  removeTransition: "Remove",
  noTransitions: "No transitions",
  noGates: "No gates",
  decide: {
    title: "Routing",
    source: "Source",
    sourceNone: "None",
    sourceOutput: "Output field",
    sourceVerdict: "Verdict",
    path: "Output path",
    when: "When",
    target: "Target",
    default: "Default target",
    addCase: "Add case",
    removeCase: "Remove case",
    noCases: "No cases",
    onMismatch: "On mismatch",
    onMismatchNone: "Fail (CONFIG)",
    onMismatchRetry: "Retry (self)",
    hint: "retry/<outcome> requires a rework block.",
  },
  hooks: {
    title: "Guardrail hooks",
    repetitionMax: "Repetition limit",
    noProgressMaxTurns: "No-progress limit",
    pathGuardAllowedPaths: "Allowed paths",
    disabled: "Disable auto-arm",
    hint: "hooks hint",
  },
  gate: {
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
  },
};

function render(node: NodeDef | null): string {
  return renderToStaticMarkup(
    createElement(NodeSideForm, { node, labels, onChange: () => {} }),
  );
}

describe("NodeSideForm — empty state", () => {
  it("renders the empty hint when no node is selected", () => {
    const html = render(null);

    expect(html).toContain('data-testid="node-side-form-empty"');
    expect(html).toContain("Select a node");
  });
});

describe("NodeSideForm — ai_coding", () => {
  it("renders the prompt action + ai_coding settings + common sections", () => {
    const html = render(nodeById("plan"));

    expect(html).toContain('data-testid="node-side-form"');
    expect(html).toContain('data-testid="node-action-prompt"');
    expect(html).toContain('data-testid="node-model"');
    expect(html).toContain('data-testid="node-thinking-effort"');
    expect(html).toContain('data-testid="node-permission-mode"');
    expect(html).toContain('data-testid="node-workspace-access"');
    expect(html).toContain('data-testid="node-skills"');
    expect(html).toContain('data-testid="node-restrictions"');
    expect(html).toContain('data-testid="node-mcps"');
    expect(html).toContain('data-testid="node-enforcement-mcps"');
    expect(html).toContain('data-testid="node-output-schema"');
    expect(html).toContain('data-testid="node-rework-max-loops"');
    expect(html).toContain('data-testid="node-rework-workspace-policies"');
    expect(html).toContain('data-testid="node-rework-comments-var"');
    // transitions editor: the node's `approve -> build` row renders
    expect(html).toContain('data-testid="node-transitions"');
    expect(html).toContain('data-testid="add-transition"');
    expect(html).toContain('data-testid="transition-outcome-0"');
    expect(html).toContain('data-testid="transition-target-0"');
    // the node's gate renders a GateForm
    expect(html).toContain('data-testid="gate-form-g1"');
  });
});

describe("NodeSideForm — cli", () => {
  it("renders the command action + cli settings, not a prompt", () => {
    const html = render(nodeById("build"));

    expect(html).toContain('data-testid="node-action-command"');
    expect(html).toContain('data-testid="node-timeout-ms"');
    expect(html).toContain('data-testid="node-environment-policy"');
    expect(html).toContain('data-testid="node-failure-class"');
    expect(html).not.toContain('data-testid="node-action-prompt"');
  });
});

describe("NodeSideForm — judge", () => {
  it("renders the prompt action + judge settings", () => {
    const html = render(nodeById("assess"));

    expect(html).toContain('data-testid="node-action-prompt"');
    expect(html).toContain('data-testid="node-model"');
    expect(html).toContain('data-testid="node-thinking-effort"');
  });
});

describe("NodeSideForm — human", () => {
  it("renders decisions + criticality, no action field", () => {
    const html = render(nodeById("review"));

    expect(html).toContain('data-testid="node-decisions"');
    expect(html).toContain('data-testid="node-criticality"');
    expect(html).toContain('data-testid="node-roles"');
    expect(html).toContain('data-testid="node-assignees"');
    expect(html).toContain('data-testid="node-allow-takeover"');
    expect(html).not.toContain('data-testid="node-action-prompt"');
    expect(html).not.toContain('data-testid="node-action-command"');
  });
});

describe("NodeSideForm — decide routing (M38)", () => {
  it("judge + decide:{from:verdict} renders the verdict cases table + default", () => {
    const html = render(nodeById("triage"));

    expect(html).toContain('data-testid="node-decide-source"');
    expect(html).toContain('data-testid="node-decide-add-case"');
    expect(html).toContain('data-testid="node-decide-case-0"');
    expect(html).toContain('data-testid="node-decide-default"');
    // the verdict source is selected
    expect(html).toContain('value="verdict"');
    // it is NOT an output-path field
    expect(html).not.toContain('data-testid="node-decide-path"');
  });

  it("ai_coding + decide:{from:output.x} renders the dot-path field + on_mismatch", () => {
    const html = render(nodeById("classify"));

    expect(html).toContain('data-testid="node-decide-source"');
    expect(html).toContain('data-testid="node-decide-path"');
    expect(html).toContain('data-testid="node-decide-onmismatch"');
    expect(html).toContain("output.triage.outcome");
    // output source has no cases table
    expect(html).not.toContain('data-testid="node-decide-case-0"');
  });

  it("omits the Routing section for a node with no output.result and no verdict gate", () => {
    // `build` is a cli node with no output.result and no verdict-producing gate.
    const html = render(nodeById("build"));

    expect(html).not.toContain('data-testid="node-decide-source"');
  });

  it("offers the Routing source for a node that declares output.result (plan)", () => {
    // `plan` declares output.result → can route from output; source select shows.
    const html = render(nodeById("plan"));

    expect(html).toContain('data-testid="node-decide-source"');
    expect(html).toContain('data-testid="node-decide-onmismatch"');
  });
});

describe("NodeSideForm — hooks (M40)", () => {
  it("ai_coding renders the hooks editor + enforcement.hooks with values", () => {
    const html = render(nodeById("plan"));

    expect(html).toContain('data-testid="node-hooks"');
    expect(html).toContain('data-testid="node-hooks-repetition-max"');
    expect(html).toContain('data-testid="node-hooks-no-progress-max-turns"');
    expect(html).toContain('data-testid="node-hooks-path-guard-allowed-paths"');
    expect(html).toContain('data-testid="node-hooks-disabled"');
    expect(html).toContain('data-testid="node-enforcement-hooks"');
    // the node's hooks values round-trip into the fields
    expect(html).toContain('value="5"');
    expect(html).toContain('value="15"');
    expect(html).toContain("src/**, lib/**");
  });

  it("judge renders the hooks editor (empty when no hooks settings)", () => {
    const html = render(nodeById("assess"));

    expect(html).toContain('data-testid="node-hooks"');
    expect(html).toContain('data-testid="node-hooks-repetition-max"');
  });

  it("omits the hooks editor for cli and human nodes", () => {
    expect(render(nodeById("build"))).not.toContain('data-testid="node-hooks"');
    expect(render(nodeById("review"))).not.toContain(
      'data-testid="node-hooks"',
    );
  });
});

describe("NodeSideForm — presentation (T2.4c)", () => {
  it("renders width/height/color inputs with values when onPresentationChange is wired", () => {
    const html = renderToStaticMarkup(
      createElement(NodeSideForm, {
        node: nodeById("plan"),
        labels,
        presentation: { width: 240, height: 96, color: "#22c55e" },
        onChange: () => {},
        onPresentationChange: () => {},
      }),
    );

    expect(html).toContain('data-testid="node-presentation"');
    expect(html).toContain('data-testid="node-presentation-width"');
    expect(html).toContain('data-testid="node-presentation-height"');
    expect(html).toContain('data-testid="node-presentation-color"');
    expect(html).toContain('value="240"');
    expect(html).toContain('value="96"');
    expect(html).toContain('value="#22c55e"');
  });

  it("omits the presentation section when onPresentationChange is absent", () => {
    const html = render(nodeById("plan"));

    expect(html).not.toContain('data-testid="node-presentation"');
  });
});
