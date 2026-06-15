// Render tests for the presentational editor top bar (T1.4). renderToStaticMarkup
// (no jsdom). Asserts the identity/lifecycle/validation/readiness chips, the
// Save/Publish gating on canManage, the Publish disabled-on-invalid gate, and the
// drawer toggles (which keep the legacy `flow-tab-*` testids).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EditorTopBar,
  type EditorTopBarLabels,
} from "@/components/flows/editor/editor-top-bar";

type Props = Parameters<typeof EditorTopBar>[0];

const labels: EditorTopBarLabels = {
  save: "Save draft",
  publish: "Publish local",
  valid: "Valid",
  issues: "$count issues",
  ready: "Ready",
  notReady: "Not ready",
  titleLabel: "Flow title",
  graph: "Graph",
  files: "Files",
  yaml: "YAML",
  diff: "Diff",
};

function render(over: Partial<Props> = {}): string {
  const props: Props = {
    labels,
    project: "Acme",
    kind: "flow",
    lifecycleLabel: "Draft",
    title: "My flow",
    onTitleChange: () => {},
    canManage: true,
    hasDraft: true,
    validation: { ok: false, issueCount: 3 },
    readinessReady: false,
    publishDisabled: true,
    publishAction: async () => {},
    openDrawer: null,
    onToggleDrawer: () => {},
    onCloseDrawers: () => {},
    ...over,
  };

  return renderToStaticMarkup(createElement(EditorTopBar, props));
}

describe("EditorTopBar — chips", () => {
  it("renders lifecycle, validation (issue count), and readiness chips", () => {
    const html = render();

    expect(html).toContain('data-testid="topbar-lifecycle"');
    expect(html).toContain("Draft");
    expect(html).toContain('data-testid="topbar-validation"');
    expect(html).toContain("3 issues");
    expect(html).toContain('data-testid="topbar-readiness"');
    expect(html).toContain("Not ready");
  });

  it("renders the valid chip when the manifest validates", () => {
    const html = render({ validation: { ok: true, issueCount: 0 } });

    expect(html).toContain("Valid");
    expect(html).not.toContain("issues");
  });

  it("renders the ready chip when the package is ready", () => {
    expect(render({ readinessReady: true })).toContain("Ready");
  });

  it("falls back to no validation chip when validation is null", () => {
    const html = render({ validation: null });

    expect(html).not.toContain('data-testid="topbar-validation"');
  });
});

describe("EditorTopBar — action gating", () => {
  it("shows Save + Publish for a manager with a draft", () => {
    const html = render();

    expect(html).toContain('data-testid="topbar-save"');
    expect(html).toContain('data-testid="topbar-publish"');
  });

  it("hides Save + Publish for a non-manager", () => {
    const html = render({ canManage: false });

    expect(html).not.toContain('data-testid="topbar-save"');
    expect(html).not.toContain('data-testid="topbar-publish"');
  });

  it("hides Publish when there is no draft yet", () => {
    const html = render({ hasDraft: false });

    expect(html).toContain('data-testid="topbar-save"');
    expect(html).not.toContain('data-testid="topbar-publish"');
  });

  it("disables Publish when the package is not valid", () => {
    const html = render({ publishDisabled: true });
    const publishIdx = html.indexOf('data-testid="topbar-publish"');
    // the rendered <button> carries the disabled attribute
    const slice = html.slice(Math.max(0, publishIdx - 200), publishIdx + 200);

    expect(slice).toContain("disabled");
  });
});

describe("EditorTopBar — drawer toggles", () => {
  it("renders the graph/files/yaml/diff toggles with legacy testids", () => {
    const html = render();

    expect(html).toContain('data-testid="flow-tab-graph"');
    expect(html).toContain('data-testid="flow-tab-files"');
    expect(html).toContain('data-testid="flow-tab-yaml"');
    expect(html).toContain('data-testid="flow-tab-diff"');
  });

  it("marks the active toggle as pressed", () => {
    const html = render({ openDrawer: "yaml" });
    const yamlIdx = html.indexOf('data-testid="flow-tab-yaml"');
    const slice = html.slice(Math.max(0, yamlIdx - 200), yamlIdx + 60);

    expect(slice).toContain('aria-pressed="true"');
  });
});
