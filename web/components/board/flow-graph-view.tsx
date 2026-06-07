"use client";

import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type {
  GraphNodeStatus,
  RunNodeStatuses,
} from "@/lib/queries/run-node-status";
import type {
  EdgeProps,
  EdgeTypes,
  Node,
  NodeProps,
  NodeTypes,
} from "@xyflow/react";
import type { ReactElement } from "react";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getBezierPath,
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
  node: Record<string, string>;
  role?: Record<string, string>;
  edge?: Record<string, string>;
  declaredGateSummary?: string;
  gateSummary?: string;
  blockingGateSummary?: string;
}

export interface FlowGraphViewProps {
  runId: string;
  topology: GraphTopology;
  layout: Record<string, { x: number; y: number }>;
  initialStatuses: RunNodeStatuses["nodes"];
  currentStepId: string | null;
  runStatus: string;
  labels: FlowGraphViewLabels;
}

interface FlowNodeBodyProps {
  label: string;
  displayLabel?: string;
  nodeTypeLabel?: string;
  nodeRole?: string;
  status: string;
  statusLabel?: string;
  isCurrent: boolean;
  rollup: string;
  declaredGateSummary?: {
    total: number;
    blocking: number;
    advisory: number;
    kinds: string[];
  };
  runtimeGateSummary?: GraphNodeStatus["gateSummary"];
  labels: {
    currentNode: string;
    declaredGateSummary?: string;
    gateSummary?: string;
    blockingGateSummary?: string;
  };
}

interface FlowEdgeLabelProps {
  label: string;
  edgeRole: string;
}

interface FlowEdgeLabelData {
  displayLabel?: string;
  edgeRole?: string;
  outcome?: string;
}

interface FlowGraphRuntimeState {
  statuses: RunNodeStatuses["nodes"];
  currentStep: string | null;
  runStatus: string;
}

function formatCount(template: string | undefined, count: number): string {
  return (template ?? "$count").replace("$count", String(count));
}

export function resolveFlowEdgeLabel(
  labels: Pick<FlowGraphViewLabels, "edge">,
  data: FlowEdgeLabelData | undefined,
  id: string,
): string {
  const edgeRole = data?.edgeRole ?? "other";

  if (edgeRole === "other") {
    return data?.displayLabel ?? data?.outcome ?? labels.edge?.other ?? id;
  }

  return labels.edge?.[edgeRole] ?? data?.displayLabel ?? data?.outcome ?? id;
}

export function applyFlowGraphStatusSnapshot(
  _state: FlowGraphRuntimeState,
  snapshot: RunNodeStatuses,
): FlowGraphRuntimeState {
  return {
    statuses: snapshot.nodes,
    currentStep: snapshot.currentStepId,
    runStatus: snapshot.runStatus,
  };
}

export function FlowEdgeLabel({
  label,
  edgeRole,
}: FlowEdgeLabelProps): ReactElement {
  return (
    <span
      className="rounded bg-paper px-1.5 py-0.5 text-[10px] leading-none text-forest-text-secondary shadow-sm"
      data-edge-role={edgeRole}
      data-testid="flow-edge-label"
    >
      {label}
    </span>
  );
}

// Presentational node body — no <Handle>, so it renders under
// renderToStaticMarkup without a ReactFlow provider. The data attributes are
// the test/e2e contract surface.
export function FlowNodeBody({
  label,
  displayLabel,
  nodeTypeLabel,
  nodeRole,
  status,
  statusLabel,
  isCurrent,
  rollup,
  declaredGateSummary,
  runtimeGateSummary,
  labels,
}: FlowNodeBodyProps): ReactElement {
  const declaredCount = declaredGateSummary?.total ?? 0;
  const runtimeGateCount = runtimeGateSummary?.total ?? 0;
  const blockingGateCount = runtimeGateSummary?.blockingTotal ?? 0;

  return (
    <div
      aria-current={isCurrent ? "step" : undefined}
      className={
        isCurrent
          ? "relative rounded-[10px] ring-2 ring-amber ring-offset-1"
          : "relative"
      }
      data-current={isCurrent ? "true" : "false"}
      data-node-role={nodeRole}
      data-node-status={status}
      data-testid="flow-node"
      title={isCurrent ? labels.currentNode : undefined}
    >
      <div className="flex h-[60px] w-[180px] flex-col justify-between rounded-[8px] border border-line bg-paper px-2 py-1.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[12px] font-medium leading-4 text-forest-text-primary">
              {displayLabel ?? label}
            </p>
            {nodeTypeLabel ? (
              <p className="truncate text-[10px] leading-3 text-forest-text-secondary">
                {nodeTypeLabel}
              </p>
            ) : null}
          </div>
          <Chip
            color={colorForNodeStatus(status, isCurrent)}
            size="sm"
            variant="soft"
          >
            <span className="font-mono text-[10px]" title={statusLabel}>
              {statusLabel ?? status}
            </span>
          </Chip>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 overflow-hidden text-[10px] leading-3 text-forest-text-secondary">
          {declaredCount > 0 ? (
            <span
              className="max-w-full truncate"
              data-testid="declared-gate-summary"
            >
              {formatCount(labels.declaredGateSummary, declaredCount)}
            </span>
          ) : null}
          {runtimeGateCount > 0 ? (
            <span
              className="max-w-full truncate"
              data-testid="runtime-gate-summary"
            >
              {formatCount(labels.gateSummary, runtimeGateCount)}
            </span>
          ) : null}
          {blockingGateCount > 0 ? (
            <span
              className="max-w-full truncate"
              data-testid="blocking-gate-summary"
            >
              {formatCount(labels.blockingGateSummary, blockingGateCount)}
            </span>
          ) : null}
        </div>
      </div>
      {rollup === "failed" || rollup === "stale" ? (
        <span data-rollup={rollup} data-testid="gate-rollup" />
      ) : null}
    </div>
  );
}

type FlowNodeRenderData = {
  label: string;
  displayLabel?: string;
  nodeTypeLabel?: string;
  nodeRole?: string;
  declaredGateSummary?: FlowNodeBodyProps["declaredGateSummary"];
  status: string;
  isCurrent: boolean;
  rollup: string;
  runtimeGateSummary?: GraphNodeStatus["gateSummary"];
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
          declaredGateSummary={d.declaredGateSummary}
          displayLabel={d.displayLabel}
          isCurrent={d.isCurrent}
          label={d.label}
          labels={labels}
          nodeRole={d.nodeRole}
          nodeTypeLabel={
            d.nodeRole
              ? (labels.role?.[d.nodeRole] ?? d.nodeTypeLabel)
              : d.nodeTypeLabel
          }
          rollup={d.rollup}
          runtimeGateSummary={d.runtimeGateSummary}
          status={d.status}
          statusLabel={labels.node[d.status] ?? d.status}
        />
        <Handle position={Position.Right} type="source" />
      </>
    );
  };
}

function makeFlowEdgeView(
  labels: FlowGraphViewLabels,
): (props: EdgeProps) => ReactElement {
  return function FlowEdgeView({
    data,
    id,
    markerEnd,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    style,
  }: EdgeProps): ReactElement {
    const [edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
    const d = data as FlowEdgeLabelData | undefined;
    const edgeRole = d?.edgeRole ?? "other";
    const label = resolveFlowEdgeLabel(labels, d, id);

    return (
      <>
        <BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <FlowEdgeLabel edgeRole={edgeRole} label={label} />
          </div>
        </EdgeLabelRenderer>
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
}: FlowGraphViewProps): ReactElement {
  const nodeTypes = useMemo<NodeTypes>(
    () => ({ flowNode: makeFlowNodeView(labels) }),
    [labels],
  );
  const edgeTypes = useMemo<EdgeTypes>(
    () => ({ flowEdge: makeFlowEdgeView(labels) }),
    [labels],
  );

  const positioned = useMemo(
    () => toFlowGraphView(topology, layout),
    [topology, layout],
  );

  const [statuses, setStatuses] = useState(initialStatuses);
  const [currentStep, setCurrentStep] = useState(currentStepId);
  const [liveRunStatus, setLiveRunStatus] = useState(runStatus);

  const nodes = useMemo<Node[]>(
    () =>
      positioned.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          status: statuses[n.id]?.status ?? "Pending",
          isCurrent: n.id === currentStep,
          rollup: statuses[n.id]?.rollup ?? "none",
          runtimeGateSummary: statuses[n.id]?.gateSummary,
        },
      })),
    [positioned, statuses, currentStep],
  );

  // Live coloring (ADR-052): refetch the lightweight graph-status snapshot ONLY
  // on an SSE event tick (debounced), never on a timer. A terminal run has no
  // live session, so useRunStream(null) yields no events and nothing refetches.
  const live = !isTerminalRunStatus(liveRunStatus);
  const { eventCount } = useRunStream(live ? runId : null, { retain: false });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

          const next = applyFlowGraphStatusSnapshot(
            {
              statuses: {},
              currentStep: null,
              runStatus: "",
            },
            snap,
          );

          setStatuses(next.statuses);
          setCurrentStep(next.currentStep);
          setLiveRunStatus(next.runStatus);
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
      data-testid="flow-graph-view"
    >
      <ReactFlow
        fitView
        edgeTypes={edgeTypes}
        edges={positioned.edges}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
