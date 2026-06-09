"use client";

import type { FlowGraphEditorLabels } from "@/components/flows/flow-graph-editor";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { ReactElement, ReactNode } from "react";

import { useState } from "react";
import dynamic from "next/dynamic";
import { stringify as stringifyYaml } from "yaml";

import { FlowDraftDiffText } from "@/components/flows/flow-draft-diff";

// ReactFlow does not SSR cleanly — mount the canvas client-only, mirroring the
// read-only M22 FlowGraphView (dynamic ssr:false).
const FlowGraphEditor = dynamic(
  () => import("@/components/flows/flow-graph-editor"),
  { ssr: false },
);

export type FlowEditorTabsLabels = {
  graphTab: string;
  yamlTab: string;
  diffTab: string;
  diffEmpty: string;
  editor: FlowGraphEditorLabels;
};

type Tab = "graph" | "yaml" | "diff";

/**
 * M27/T-A8: the editing surface inside the authored-flow form. A single
 * `flowYaml` value drives all tabs (canvas edits serialize into it), carried by
 * the hidden `name="flowYaml"` input so the existing `updateAuthoredFlowAction`
 * save path is reused unchanged. The canvas is seeded once from the
 * server-compiled topology/layout (compile is server-only); when the draft does
 * not compile, only the raw-YAML tab is offered.
 */
export function FlowEditorTabs({
  initialYaml,
  initialManifest,
  topology,
  layout,
  draftVersion,
  diff,
  labels,
  disabled,
  canvasAvailable,
}: {
  initialYaml: string;
  initialManifest: FlowYamlV1 | null;
  topology: GraphTopology | null;
  layout: FlowLayout | null;
  draftVersion: number;
  diff: string;
  labels: FlowEditorTabsLabels;
  disabled: boolean;
  canvasAvailable: boolean;
}): ReactElement {
  const [yaml, setYaml] = useState(initialYaml);
  const [tab, setTab] = useState<Tab>(canvasAvailable ? "graph" : "yaml");

  return (
    <div className="grid gap-3" data-testid="flow-editor-tabs">
      <input name="flowYaml" type="hidden" value={yaml} />

      <div className="flex flex-wrap gap-1.5">
        {canvasAvailable ? (
          <TabButton
            active={tab === "graph"}
            testid="flow-tab-graph"
            onClick={() => setTab("graph")}
          >
            {labels.graphTab}
          </TabButton>
        ) : null}
        <TabButton
          active={tab === "yaml"}
          testid="flow-tab-yaml"
          onClick={() => setTab("yaml")}
        >
          {labels.yamlTab}
        </TabButton>
        {canvasAvailable ? (
          <TabButton
            active={tab === "diff"}
            testid="flow-tab-diff"
            onClick={() => setTab("diff")}
          >
            {labels.diffTab}
          </TabButton>
        ) : null}
      </div>

      {tab === "graph" &&
      canvasAvailable &&
      initialManifest &&
      topology &&
      layout ? (
        <FlowGraphEditor
          draftVersion={draftVersion}
          initialManifest={initialManifest}
          labels={labels.editor}
          layout={layout}
          topology={topology}
          onChange={({ manifest }) => setYaml(stringifyYaml(manifest))}
        />
      ) : null}

      {tab === "yaml" ? (
        <textarea
          className="min-h-[620px] resize-y rounded-lg border border-line bg-ivory px-3 py-3 font-mono text-[12px] leading-[1.55] text-ink outline-none focus:border-amber disabled:opacity-70"
          data-testid="flow-yaml-textarea"
          disabled={disabled}
          spellCheck={false}
          value={yaml}
          onChange={(event) => setYaml(event.target.value)}
        />
      ) : null}

      {tab === "diff" ? (
        <FlowDraftDiffText diff={diff} emptyLabel={labels.diffEmpty} />
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  testid,
  onClick,
  children,
}: {
  active: boolean;
  testid: string;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      className={
        active
          ? "rounded-md border border-amber-line bg-amber-soft px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-amber"
          : "rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-2 hover:bg-ivory"
      }
      data-testid={testid}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
