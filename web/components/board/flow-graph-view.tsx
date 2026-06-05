"use client";

import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type { RunNodeStatuses } from "@/lib/queries/run-node-status";
import type { Node, NodeProps, NodeTypes } from "@xyflow/react";
import type { ReactElement } from "react";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { Chip } from "@heroui/react";

import {
  colorForNodeStatus,
  isTerminalRunStatus,
  toFlowGraphView,
} from "@/lib/board/flow-graph-view-layout";
import { useRunStream } from "@/lib/use-run-stream";

import "@xyflow/react/dist/style.css";

export interface FlowGraphViewLabels {
  title: string;
  empty: string;
  currentNode: string;
  saveError: string;
  node: Record<string, string>;
}

export interface FlowGraphViewProps {
  runId: string;
  topology: GraphTopology;
  layout: Record<string, { x: number; y: number }>;
  initialStatuses: RunNodeStatuses["nodes"];
  currentStepId: string | null;
  runStatus: string;
  labels: FlowGraphViewLabels;
  editable: boolean;
}

interface FlowNodeBodyProps {
  label: string;
  status: string;
  isCurrent: boolean;
  rollup: string;
  labels: { currentNode: string };
}

// Presentational node body — no <Handle>, so it renders under
// renderToStaticMarkup without a ReactFlow provider. The data attributes are
// the test/e2e contract surface.
export function FlowNodeBody({
  label,
  status,
  isCurrent,
  rollup,
  labels,
}: FlowNodeBodyProps): ReactElement {
  return (
    <div
      aria-current={isCurrent ? "step" : undefined}
      className={
        isCurrent
          ? "relative rounded-[10px] ring-2 ring-amber ring-offset-1"
          : "relative"
      }
      data-current={isCurrent ? "true" : "false"}
      data-node-status={status}
      data-testid="flow-node"
      title={isCurrent ? labels.currentNode : undefined}
    >
      <Chip
        color={colorForNodeStatus(status, isCurrent)}
        size="sm"
        variant="soft"
      >
        <span className="font-mono text-[11px]">{label}</span>
      </Chip>
      {rollup === "failed" || rollup === "stale" ? (
        <span data-rollup={rollup} data-testid="gate-rollup" />
      ) : null}
    </div>
  );
}

type FlowNodeRenderData = {
  label: string;
  status: string;
  isCurrent: boolean;
  rollup: string;
};

// A nodeType render fn closing over the translation labels: source/target
// handles wrap the presentational body so the canvas can draw edges.
function makeFlowNodeView(
  labels: FlowGraphViewLabels,
): (props: NodeProps) => ReactElement {
  return function FlowNodeView({ data }: NodeProps): ReactElement {
    const d = data as unknown as FlowNodeRenderData;

    return (
      <>
        <Handle position={Position.Left} type="target" />
        <FlowNodeBody
          isCurrent={d.isCurrent}
          label={d.label}
          labels={labels}
          rollup={d.rollup}
          status={d.status}
        />
        <Handle position={Position.Right} type="source" />
      </>
    );
  };
}

export default function FlowGraphView({
  runId,
  topology,
  layout,
  initialStatuses,
  currentStepId,
  runStatus,
  labels,
  editable,
}: FlowGraphViewProps): ReactElement {
  const nodeTypes = useMemo<NodeTypes>(
    () => ({ flowNode: makeFlowNodeView(labels) }),
    [labels],
  );

  const positioned = useMemo(
    () => toFlowGraphView(topology, layout),
    [topology, layout],
  );

  const [statuses, setStatuses] = useState(initialStatuses);
  const [currentStep, setCurrentStep] = useState(currentStepId);
  const [saveError, setSaveError] = useState<string | null>(null);

  const nodes = useMemo<Node[]>(
    () =>
      positioned.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          status: statuses[n.id]?.status ?? "Pending",
          isCurrent: n.id === currentStep,
          rollup: statuses[n.id]?.rollup ?? "none",
        },
      })),
    [positioned, statuses, currentStep],
  );

  const onNodeDragStop = useCallback(
    async (_e: unknown, node: Node): Promise<void> => {
      try {
        const res = await fetch(`/api/runs/${runId}/graph/layout`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nodeId: node.id,
            x: node.position.x,
            y: node.position.y,
          }),
        });

        if (!res.ok) setSaveError(labels.saveError);
      } catch {
        setSaveError(labels.saveError);
      }
    },
    [runId, labels],
  );

  // Live coloring (ADR-052): refetch the lightweight graph-status snapshot ONLY
  // on an SSE event tick (debounced), never on a timer. A terminal run has no
  // live session, so useRunStream(null) yields no events and nothing refetches.
  const live = !isTerminalRunStatus(runStatus);
  const { events } = useRunStream(live ? runId : null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventCount = events.length;

  useEffect(() => {
    if (!live) return;
    if (eventCount === 0) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/runs/${runId}/graph-status`);

          if (!res.ok) return;
          const snap = (await res.json()) as RunNodeStatuses;

          setStatuses(snap.nodes);
          setCurrentStep(snap.currentStepId);
        } catch {
          /* a transient status refetch failure leaves the last snapshot */
        }
      })();
    }, 1000);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [eventCount, live, runId]);

  return (
    <div
      className="h-[420px] w-full overflow-hidden rounded-[10px] border border-line bg-paper"
      data-editable={String(editable)}
      data-testid="flow-graph-view"
    >
      <ReactFlow
        fitView
        edges={positioned.edges}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={editable}
        onNodeDragStop={editable ? onNodeDragStop : undefined}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      {saveError ? <p role="alert">{saveError}</p> : null}
    </div>
  );
}
