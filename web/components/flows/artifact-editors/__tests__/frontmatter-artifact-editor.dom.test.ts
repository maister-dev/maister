// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  FrontmatterArtifactEditor,
  type FrontmatterArtifactEditorLabels,
} from "@/components/flows/artifact-editors/frontmatter-artifact-editor";
import { validateArtifactContent } from "@/lib/flows/artifact-validate";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const labels: FrontmatterArtifactEditorLabels = {
  frontmatterHeading: "Frontmatter",
  bodyHeading: "Body",
  name: "Name",
  description: "Description",
  agentWorkspace: "Workspace",
  agentWorkspaceRef: "Workspace ref",
  agentMode: "Mode",
  agentTriggers: "Triggers",
  agentRiskTier: "Risk tier",
  agentRunner: "Runner",
  agentRecommendedHeading: "Recommended",
  agentRecommendedRunner: "Recommended runner",
  agentRecommendedCronExpr: "Cron",
  agentRecommendedCronTz: "Timezone",
  agentRecommendedEvents: "Events",
  agentCapabilityProfile: "Capability profile",
  agentCapabilityProfileInvalid: "Invalid capability profile",
  allowedPaths: "Allowed paths",
  forbiddenPaths: "Forbidden paths",
  allowedCommands: "Allowed commands",
  requireStructuredResponse: "Structured response",
  listHint: "One per line",
  guardrailNotice: "Advisory",
  malformedNotice: "Malformed",
  rawHeading: "Raw",
  agentSchemaWarning: "Agent invalid",
  subagentSchemaWarning: "Subagent invalid",
};

const content = `---
name: reviewer
description: Reviews changes
workspace: repo_read
workspace_ref: trigger
mode: session
triggers: [manual]
risk_tier: read_only
capability_profile:
  mcps: [github]
---
Review the change.
`;

describe("FrontmatterArtifactEditor capability profile", () => {
  it("projects invalid JSON into canonical draft content and recovers on valid input", () => {
    let latest = content;
    const node = document.createElement("div");
    const root = createRoot(node);

    roots.push(root);
    document.body.append(node);

    function Host() {
      const [value, setValue] = useState(content);

      return createElement(FrontmatterArtifactEditor, {
        content: value,
        kind: "agent_definition",
        labels,
        onChange: (next: string) => {
          latest = next;
          setValue(next);
        },
      });
    }

    act(() => root.render(createElement(Host)));
    const textarea = node.querySelector<HTMLTextAreaElement>(
      '[data-testid="agent-capability-profile"]',
    );

    expect(textarea).not.toBeNull();
    if (!textarea) throw new Error("capability profile field missing");

    const change = (next: string): void => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;

      if (!setter) throw new Error("textarea value setter missing");
      setter.call(textarea, next);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };

    act(() => {
      change("{broken");
    });

    expect(
      [...node.querySelectorAll('[role="alert"]')].some((alert) =>
        alert.textContent?.includes("Invalid capability profile"),
      ),
    ).toBe(true);
    expect(
      validateArtifactContent({
        manifest: null,
        files: [
          {
            kind: "agent_definition",
            path: "maister-agents/reviewer.md",
            content: latest,
          },
        ],
      }).some((issue) => issue.severity === "block"),
    ).toBe(true);

    act(() => {
      change('{"mcps":["linear"]}');
    });

    expect(node.querySelector('[role="alert"]')).toBeNull();
    expect(
      validateArtifactContent({
        manifest: null,
        files: [
          {
            kind: "agent_definition",
            path: "maister-agents/reviewer.md",
            content: latest,
          },
        ],
      }).filter((issue) => issue.severity === "block"),
    ).toEqual([]);
  });
});
