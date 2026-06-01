import type { EnforcementSnapshotEntry } from "@/lib/db/schema";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FlowSettingsPanel,
  type FlowSettingsPanelLabels,
  type SettingsNodeView,
} from "@/components/board/panels/flow-settings-panel";

// ---------------------------------------------------------------------------
// CONTRACT under test — `components/board/panels/flow-settings-panel.tsx`
// (M11c Phase 4.1). A PURE-RENDER server component (no `useTranslations`, no DB):
// it takes a pre-built view-model (from lib/flows/settings-view.ts) + threaded
// i18n labels and renders each ai_coding/judge node's capability classes tagged
// enforced / instructed / refused, plus a refusal-reason line for a refused run.
//
//   export interface FlowSettingsPanelLabels {
//     title: string;
//     verdictEnforced: string;
//     verdictInstructed: string;
//     verdictRefused: string;
//     noConstraints: string;
//     refusalReason: string;          // label preceding the refusal detail
//     classLabel: (cls: EnforcementSnapshotEntry["class"]) => string;
//   }
//   export interface FlowSettingsPanelProps {
//     nodes: SettingsNodeView[];
//     refusalReason?: string | null;  // present only for a launch-refused run
//     labels: FlowSettingsPanelLabels;
//   }
//
// This mirrors the established render-test harness (flight-card.test.ts,
// run-timeline.test.ts): components export a pure render fn + a *Labels type +
// the view-model type, tested via renderToStaticMarkup. No testing-library /
// jsdom is installed; do not introduce one.
// ---------------------------------------------------------------------------

const labels: FlowSettingsPanelLabels = {
  title: "Settings enforcement",
  verdictEnforced: "enforced",
  verdictInstructed: "instructed",
  verdictRefused: "refused",
  noConstraints: "No constrained capabilities",
  refusalReason: "Refused at launch",
  classLabel: (cls) => cls,
};

function render(
  nodes: SettingsNodeView[],
  refusalReason?: string | null,
): string {
  return renderToStaticMarkup(
    createElement(FlowSettingsPanel, { nodes, refusalReason, labels }),
  );
}

function node(
  nodeId: string,
  nodeType: "ai_coding" | "judge",
  classes: Array<{
    class: EnforcementSnapshotEntry["class"];
    verdict: EnforcementSnapshotEntry["verdict"];
  }>,
): SettingsNodeView {
  return { nodeId, nodeType, classes };
}

describe("FlowSettingsPanel — three verdict states", () => {
  it("renders instructed, refused, and enforced verdict labels", () => {
    const html = render([
      node("implement", "ai_coding", [
        { class: "mcps", verdict: "refused" },
        { class: "tools", verdict: "instructed" },
      ]),
      node("verdict", "judge", [
        { class: "permissionMode", verdict: "enforced" },
      ]),
    ]);

    expect(html).toContain("instructed");
    expect(html).toContain("refused");
    expect(html).toContain("enforced");
    // node ids surface so the reader can map verdicts back to nodes.
    expect(html).toContain("implement");
    expect(html).toContain("verdict");
  });

  it("renders the no-constraints label for a node with empty classes", () => {
    const html = render([node("bare", "ai_coding", [])]);

    expect(html).toContain("No constrained capabilities");
  });

  it("renders the refusal-reason line for a launch-refused run", () => {
    const html = render(
      [node("implement", "ai_coding", [{ class: "mcps", verdict: "refused" }])],
      'node "implement" declares strict enforcement of "mcps"',
    );

    expect(html).toContain("Refused at launch");
    // renderToStaticMarkup HTML-escapes quotes in text children (&quot;); a real
    // browser renders them back to ". Assert on the escaped form the React text
    // child legitimately produces — the panel uses a normal auto-escaped child,
    // never dangerouslySetInnerHTML.
    expect(html).toContain("strict enforcement of &quot;mcps&quot;");
  });

  it("omits the refusal-reason line when there is no refusal", () => {
    const html = render(
      [
        node("implement", "ai_coding", [
          { class: "tools", verdict: "instructed" },
        ]),
      ],
      null,
    );

    expect(html).not.toContain("Refused at launch");
  });
});

// ---------------------------------------------------------------------------
// SECRET-LEAK GUARD (skill: server-only-secrets). The panel renders ONLY the
// view-model + threaded labels. Even if a caller mistakenly passed secret-ish
// content, the panel props/markup must not surface token/key/secret material.
// Here we prove the rendered markup carries none of those substrings for a
// normal view-model.
// ---------------------------------------------------------------------------

describe("FlowSettingsPanel — no secret leakage in rendered markup", () => {
  it("markup matches NEITHER /token/i NOR /key/i NOR /secret/i", () => {
    const html = render([
      node("implement", "ai_coding", [
        { class: "mcps", verdict: "refused" },
        { class: "workspaceAccess", verdict: "instructed" },
      ]),
    ]);

    expect(html).not.toMatch(/token/i);
    expect(html).not.toMatch(/secret/i);
    // `key` appears as a React reserved prop name only in source, never in the
    // static markup; assert it is absent from the rendered output too.
    expect(html).not.toMatch(/key/i);
  });
});
