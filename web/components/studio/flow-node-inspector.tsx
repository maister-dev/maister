"use client";

import type { NodeSideFormLabels } from "@/components/flows/node-form/node-side-form";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { ReactElement } from "react";

import { useState } from "react";

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
  // "auto" = picker beside the form on wide viewports (the stacked-section
  // layout). "stacked" = always picker-over-form, for a narrow right rail.
  orientation = "auto",
}: {
  nodes: NodeDef[];
  labels: FlowNodeInspectorLabels;
  orientation?: "auto" | "stacked";
}): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(
    nodes[0] ? String((nodes[0] as { id?: unknown }).id ?? "") : null,
  );

  const selected =
    nodes.find(
      (node) => String((node as { id?: unknown }).id) === selectedId,
    ) ?? null;

  return (
    <div
      className={
        orientation === "stacked"
          ? "flex flex-col gap-4"
          : "grid grid-cols-1 gap-4 lg:grid-cols-[200px_minmax(0,1fr)]"
      }
    >
      <div className="flex flex-col gap-2">
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink">
          {labels.listTitle}
        </h3>
        <p className="font-mono text-[10px] leading-[1.4] text-mute">
          {labels.listHint}
        </p>
        <ul className="flex flex-col gap-1" data-testid="flow-node-picker">
          {nodes.map((node) => {
            const id = String((node as { id?: unknown }).id ?? "");
            const type = String((node as { type?: unknown }).type ?? "");
            const isActive = id === selectedId;

            return (
              <li key={id}>
                <button
                  aria-current={isActive ? "true" : undefined}
                  className={
                    isActive
                      ? "w-full rounded-lg border border-amber-line bg-amber-soft px-2.5 py-1.5 text-left font-mono text-[11px] text-ink"
                      : "w-full rounded-lg border border-line-soft bg-ivory px-2.5 py-1.5 text-left font-mono text-[11px] text-ink-2 transition-colors hover:border-line"
                  }
                  data-testid={`flow-node-pick-${id}`}
                  type="button"
                  onClick={() => setSelectedId(id)}
                >
                  <span className="block truncate font-semibold">{id}</span>
                  <span className="block truncate text-[9.5px] uppercase tracking-[0.08em] text-mute">
                    {type}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="min-w-0">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink">
            {labels.inspectorTitle}
          </h3>
          <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[9.5px] uppercase tracking-[0.06em] text-mute">
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
    </div>
  );
}
