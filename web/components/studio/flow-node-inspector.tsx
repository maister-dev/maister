"use client";

import type { NodeSideFormLabels } from "@/components/flows/node-form/node-side-form";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { ReactElement } from "react";

import { NodeSideForm } from "@/components/flows/node-form/node-side-form";

type NodeDef = NonNullable<FlowYamlV1["nodes"]>[number];

export interface FlowNodeInspectorLabels {
  listTitle: string;
  listHint: string;
  inspectorTitle: string;
  readOnlyNotice: string;
  nodeForm: NodeSideFormLabels;
}

// Read-only node inspector for the package-viewer flow detail (T1.4). The static
// canvas has no click-to-select wiring, so a node picker selects the inspected
// node; NodeSideForm renders its full config in read-only mode (no mutation
// controls, edits are no-ops). Only manifest node defs cross the wire — never a
// disk handle.
export function FlowNodeInspector({
  nodes,
  labels,
  selectedNodeId,
}: {
  nodes: NodeDef[];
  labels: FlowNodeInspectorLabels;
  selectedNodeId: string | null;
}): ReactElement {
  const selected =
    nodes.find(
      (node) => String((node as { id?: unknown }).id) === selectedNodeId,
    ) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink">
            {labels.inspectorTitle}
          </h3>
          <p className="mt-1 font-mono text-[10px] leading-[1.4] text-mute">
            {labels.listHint}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-line bg-ivory px-2 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-mute">
          {labels.readOnlyNotice}
        </span>
      </div>

      <NodeSideForm
        readOnly
        labels={labels.nodeForm}
        node={selected}
        onChange={() => {}}
      />
    </div>
  );
}
