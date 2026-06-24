"use client";

import type { ComponentProps, ReactElement } from "react";

import { useState } from "react";

import { FlowGraphViewSection as GraphView } from "@/components/board/flow-graph-view-section";
import { CodeEditor } from "@/components/flows/code-editor";
import { FlowNodeInspector as NodeInspector } from "@/components/studio/flow-node-inspector";
import { ForkToEditButton } from "@/components/studio/fork-to-edit-button";
import { buildFlowNodeTooltipsFromNodes } from "@/lib/flows/graph/node-tooltips";

function firstNodeId(
  nodes: ComponentProps<typeof NodeInspector>["nodes"],
): string | null {
  return nodes[0] ? String((nodes[0] as { id?: unknown }).id ?? "") : null;
}

// Read-only flow viewer for the package-viewer flow detail. Mirrors the Flow
// Studio editor shape: a dominant canvas with a canvas-selected node properties
// rail, plus YAML as an opt-in central view. Only manifest data crosses the wire,
// never a disk handle.
export function StudioFlowViewer({
  topology,
  layout,
  graphLabels,
  graphAvailable,
  graphUnavailableLabel,
  nodes,
  inspectorLabels,
  flowYaml,
  flowPath,
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
  flowPath?: string;
  graphTitle: string;
  yamlTitle: string;
  // Package name (Phase A ref) when the viewer may fork-to-edit; undefined hides
  // the Edit control. Keeps the immutable-installed model: edit = fork to local.
  forkRef?: string;
}): ReactElement {
  const [yamlOpen, setYamlOpen] = useState(
    !graphAvailable && Boolean(flowYaml),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    firstNodeId(nodes),
  );
  const nodeTooltips = buildFlowNodeTooltipsFromNodes(nodes);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-bold tracking-[-0.01em] text-ink">
          {graphTitle}
        </h2>
        <div className="flex items-center gap-2">
          {forkRef ? (
            <ForkToEditButton refName={forkRef} targetPath={flowPath} />
          ) : null}
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_440px] xl:grid-cols-[minmax(0,1fr)_500px]">
        <div className="min-w-0">
          {yamlOpen && flowYaml ? (
            <div
              className="h-[min(66vh,720px)] min-h-[520px] overflow-hidden rounded-[10px] border border-line bg-paper"
              data-testid="flow-yaml-panel"
            >
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                    {yamlTitle}
                  </span>
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
            </div>
          ) : graphAvailable && topology && layout ? (
            <GraphView
              heightClassName="h-[min(66vh,720px)] min-h-[520px]"
              labels={graphLabels}
              layout={layout}
              nodeTooltips={nodeTooltips}
              selectedNodeId={selectedNodeId}
              topology={topology}
              onSelectNode={setSelectedNodeId}
            />
          ) : (
            <p
              className="flex h-[min(66vh,720px)] min-h-[520px] items-center justify-center rounded-lg border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute"
              data-testid="flow-graph-unavailable"
            >
              {graphUnavailableLabel}
            </p>
          )}
        </div>

        {nodes.length > 0 ? (
          <aside
            className="h-[min(66vh,720px)] min-h-[520px] overflow-auto rounded-xl border border-line bg-paper p-3"
            data-testid="flow-node-inspector"
          >
            <NodeInspector
              labels={inspectorLabels}
              nodes={nodes}
              selectedNodeId={selectedNodeId}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
