"use client";

import type { ComponentProps, ReactElement } from "react";

import { useState } from "react";

import { FlowGraphViewSection as GraphView } from "@/components/board/flow-graph-view-section";
import { CodeEditor } from "@/components/flows/code-editor";
import { FlowNodeInspector as NodeInspector } from "@/components/studio/flow-node-inspector";
import { ForkToEditButton } from "@/components/studio/fork-to-edit-button";

// Read-only flow viewer for the package-viewer flow detail. Mirrors the Flow
// Studio editor SHAPE (ADR-092): a dominant canvas with the node properties on a
// right rail and the YAML behind a top-bar toggle drawer — NOT the legacy stacked
// column (canvas → node block → always-on YAML). It composes the existing
// read-only pieces (FlowGraphView, FlowNodeInspector, CodeEditor); only manifest
// data crosses the wire, never a disk handle.
export function StudioFlowViewer({
  topology,
  layout,
  graphLabels,
  graphAvailable,
  graphUnavailableLabel,
  nodes,
  inspectorLabels,
  flowYaml,
  graphTitle,
  yamlTitle,
  forkRef,
}: {
  topology: ComponentProps<typeof GraphView>["topology"] | null;
  layout: ComponentProps<typeof GraphView>["layout"] | null;
  graphLabels: ComponentProps<typeof GraphView>["labels"];
  graphAvailable: boolean;
  graphUnavailableLabel: string;
  nodes: ComponentProps<typeof NodeInspector>["nodes"];
  inspectorLabels: ComponentProps<typeof NodeInspector>["labels"];
  flowYaml: string | null;
  graphTitle: string;
  yamlTitle: string;
  // Package name (Phase A ref) when the viewer may fork-to-edit; undefined hides
  // the Edit control. Keeps the immutable-installed model: edit = fork to local.
  forkRef?: string;
}): ReactElement {
  const [yamlOpen, setYamlOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-bold tracking-[-0.01em] text-ink">
          {graphTitle}
        </h2>
        <div className="flex items-center gap-2">
          {forkRef ? <ForkToEditButton refName={forkRef} /> : null}
          {flowYaml ? (
            <button
              aria-pressed={yamlOpen}
              className={
                yamlOpen
                  ? "rounded-[10px] border border-amber bg-amber-soft px-3 py-1.5 text-[12px] font-semibold text-ink"
                  : "rounded-[10px] border border-line bg-ivory px-3 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:border-amber"
              }
              data-testid="flow-yaml-toggle"
              type="button"
              onClick={() => setYamlOpen((open) => !open)}
            >
              {yamlTitle}
            </button>
          ) : null}
        </div>
      </div>

      <div className="relative">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            {graphAvailable && topology && layout ? (
              <GraphView
                labels={graphLabels}
                layout={layout}
                topology={topology}
              />
            ) : (
              <p
                className="rounded-lg border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute"
                data-testid="flow-graph-unavailable"
              >
                {graphUnavailableLabel}
              </p>
            )}
          </div>

          {nodes.length > 0 ? (
            <aside
              className="overflow-auto rounded-xl border border-line bg-paper p-3 lg:h-[420px]"
              data-testid="flow-node-inspector"
            >
              <NodeInspector
                labels={inspectorLabels}
                nodes={nodes}
                orientation="stacked"
              />
            </aside>
          ) : null}
        </div>

        {yamlOpen && flowYaml ? (
          <div
            className="absolute inset-y-0 right-0 z-10 flex w-full max-w-[640px] flex-col rounded-xl border border-line bg-paper shadow-lg"
            data-testid="flow-yaml-drawer"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                {yamlTitle}
              </span>
              <button
                aria-label="close"
                className="rounded-md border border-line px-2 py-1 font-mono text-[10px] text-ink-2 hover:bg-ivory"
                type="button"
                onClick={() => setYamlOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <CodeEditor
                readOnly
                ariaLabel={yamlTitle}
                kind="flow"
                value={flowYaml}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
