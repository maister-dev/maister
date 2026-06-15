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
  type FlowLayoutOverride,
} from "@/lib/board/flow-graph-view-layout";
import { nodeVisual } from "@/lib/flows/node-visuals";
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

// Run coupling is optional: present → live status overlay (SSE + /graph-status,
// chips, current-node ring); absent → static topology + presentation layout.
export interface FlowGraphRunContext {
  runId: string;
  initialStatuses: RunNodeStatuses["nodes"];
  currentStepId: string | null;
  runStatus: string;
}

export interface FlowGraphViewProps {
  topology: GraphTopology;
  layout: Record<string, FlowLayoutOverride>;
  labels: FlowGraphViewLabels;
  runContext?: FlowGraphRunContext;
}

interface FlowNodeBodyProps {
  label: string;
  // Typed node kind (ai_coding | judge | cli | check | human) → the colored
  // identity icon chip (T1.1). Absent/unknown → a neutral dot, never a throw.
  nodeType?: string;
  displayLabel?: string;
  nodeTypeLabel?: string;
  nodeRole?: string;
  status: string;
  statusLabel?: string;
  isCurrent: boolean;
  rollup: string;
  // Additive presentation (ADR-064): authored size + color paint the node box in
  // both the read-only view and the editor canvas; absent → default dims/border.
  presentationWidth?: number;
  presentationHeight?: number;
  presentationColor?: string;
  // Static (run-less) render: drop the status chip, current-node ring, and the
  // run-only gate-rollup — leaving pure topology + declared-gate metadata.
  presentationOnly?: boolean;
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

// Inline SVG glyphs keyed by `node-visuals.ts` `iconName` (no icon library —
// matches the chrome left-rail convention). Stroked via `currentColor`, which the
// chip sets to the type's forest token.
const NODE_ICON_PATHS: Record<string, ReactElement> = {
  bot: (
    <>
      <rect height="7" rx="2" width="10" x="3" y="5.5" />
      <path d="M8 5.5V2.9" />
      <circle cx="8" cy="2.3" r="0.7" />
      <path d="M6 8.6v1.4M10 8.6v1.4" />
    </>
  ),
  gavel: (
    <>
      <path d="M4 12.5h5.5" />
      <path d="M6.2 10.7 10.4 6.5" />
      <rect
        height="2.8"
        rx="0.5"
        transform="rotate(45 10.6 5.6)"
        width="4.2"
        x="8.5"
        y="4.2"
      />
    </>
  ),
  terminal: (
    <>
      <path d="M3.6 5 6.4 7.8 3.6 10.6" />
      <path d="M7.9 11h4.6" />
    </>
  ),
  shield: (
    <>
      <path d="M8 2.4 13 4.3v3.6c0 3-2.2 4.9-5 5.7-2.8-.8-5-2.7-5-5.7V4.3z" />
      <path d="M5.9 7.9 7.3 9.4 10.2 6.3" />
    </>
  ),
  person: (
    <>
      <circle cx="8" cy="5.4" r="2.3" />
      <path d="M3.6 13c0-2.5 2-4.3 4.4-4.3s4.4 1.8 4.4 4.3" />
    </>
  ),
  puzzle: (
    <path d="M3.6 4.3h2.9a1.3 1.3 0 0 1 2.6 0h2.9v2.9a1.3 1.3 0 0 1 0 2.6v2.3h-8.4v-2.3a1.3 1.3 0 0 0 0-2.6z" />
  ),
  file: (
    <>
      <path d="M4.6 2.5h4.1l3 3v8h-7.1z" />
      <path d="M8.6 2.5V5.6h3" />
    </>
  ),
  link: (
    <>
      <path d="M6.6 9.4 9.4 6.6" />
      <path d="M7.3 5.2 8.7 3.8a2.4 2.4 0 0 1 3.4 3.4L10.6 8.6" />
      <path d="M8.7 10.8 7.3 12.2a2.4 2.4 0 0 1-3.4-3.4L5.4 7.4" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="3" />,
};

function NodeTypeIcon({ name }: { name: string }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
    >
      {NODE_ICON_PATHS[name] ?? NODE_ICON_PATHS.dot}
    </svg>
  );
}

// Presentational node body — no <Handle>, so it renders under
// renderToStaticMarkup without a ReactFlow provider. The data attributes are
// the test/e2e contract surface.
export function FlowNodeBody({
  label,
  nodeType,
  displayLabel,
  nodeTypeLabel,
  nodeRole,
  status,
  statusLabel,
  isCurrent,
  rollup,
  presentationOnly,
  presentationWidth,
  presentationHeight,
  presentationColor,
  declaredGateSummary,
  runtimeGateSummary,
  labels,
}: FlowNodeBodyProps): ReactElement {
  const declaredCount = declaredGateSummary?.total ?? 0;
  const runtimeGateCount = runtimeGateSummary?.total ?? 0;
  const blockingGateCount = runtimeGateSummary?.blockingTotal ?? 0;

  const typeVisual = nodeType ? nodeVisual(nodeType) : null;

  const boxStyle: {
    width?: number;
    height?: number;
    borderColor?: string;
    background?: string;
  } = {};

  if (typeof presentationWidth === "number") boxStyle.width = presentationWidth;
  if (typeof presentationHeight === "number")
    boxStyle.height = presentationHeight;
  // Author presentationColor (ADR-064) wins the border; otherwise tint the border
  // and a faint wash with the node-type hue so the card itself reads its type.
  if (presentationColor) {
    boxStyle.borderColor = presentationColor;
  } else if (typeVisual) {
    boxStyle.borderColor = `color-mix(in srgb, var(--${typeVisual.colorToken}) 45%, var(--line))`;
    boxStyle.background = `color-mix(in srgb, var(--${typeVisual.colorToken}) 9%, var(--paper))`;
  }
  const hasBoxStyle = Object.keys(boxStyle).length > 0;

  return (
    <div
      aria-current={isCurrent ? "step" : undefined}
      className={
        isCurrent
          ? "relative rounded-[10px] ring-2 ring-amber ring-offset-1"
          : "relative"
      }
      data-current={presentationOnly ? undefined : isCurrent ? "true" : "false"}
      data-node-role={nodeRole}
      data-node-status={presentationOnly ? undefined : status}
      data-testid="flow-node"
      title={isCurrent ? labels.currentNode : undefined}
    >
      <div
        className="flex h-[60px] w-[180px] flex-col justify-between rounded-[8px] border border-line bg-paper px-2 py-1.5"
        style={hasBoxStyle ? boxStyle : undefined}
      >
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-1.5">
            {typeVisual ? (
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border"
                data-node-type={nodeType}
                data-testid="node-type-icon"
                style={{
                  color: `var(--${typeVisual.colorToken})`,
                  background: `var(--${typeVisual.colorToken}-soft)`,
                  borderColor: `color-mix(in srgb, var(--${typeVisual.colorToken}) 40%, transparent)`,
                }}
                title={nodeTypeLabel}
              >
                <NodeTypeIcon name={typeVisual.iconName} />
              </span>
            ) : null}
            <div className="min-w-0">
              <p className="truncate text-[12px] font-medium leading-4 text-forest-text-primary">
                {displayLabel ?? label}
              </p>
              {nodeTypeLabel ? (
                <p
                  className="truncate text-[10px] font-medium leading-3 text-forest-text-secondary"
                  style={
                    typeVisual
                      ? { color: `var(--${typeVisual.colorToken})` }
                      : undefined
                  }
                >
                  {nodeTypeLabel}
                </p>
              ) : null}
            </div>
          </div>
          {presentationOnly ? null : (
            <Chip
              color={colorForNodeStatus(status, isCurrent)}
              size="sm"
              variant="soft"
            >
              <span className="font-mono text-[10px]" title={statusLabel}>
                {statusLabel ?? status}
              </span>
            </Chip>
          )}
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
  nodeType?: string;
  displayLabel?: string;
  nodeTypeLabel?: string;
  nodeRole?: string;
  declaredGateSummary?: FlowNodeBodyProps["declaredGateSummary"];
  status?: string;
  isCurrent?: boolean;
  rollup?: string;
  runtimeGateSummary?: GraphNodeStatus["gateSummary"];
  presentationColor?: string;
  presentationWidth?: number;
  presentationHeight?: number;
};

// A nodeType render fn closing over the translation labels: source/target
// handles wrap the presentational body so the canvas can draw edges. When
// `presentationOnly` (static run-less view) the body drops status/ring/rollup —
// the canvas then carries pure topology + presentation layout only.
function makeFlowNodeView(
  labels: FlowGraphViewLabels,
  presentationOnly = false,
): (props: NodeProps) => ReactElement {
  return function FlowNodeView({ data }: NodeProps): ReactElement {
    const d = data as unknown as FlowNodeRenderData;
    const status = d.status ?? "Pending";

    return (
      <>
        <Handle position={Position.Left} type="target" />
        <FlowNodeBody
          declaredGateSummary={d.declaredGateSummary}
          displayLabel={d.displayLabel}
          isCurrent={d.isCurrent ?? false}
          label={d.label}
          labels={labels}
          nodeRole={d.nodeRole}
          nodeType={d.nodeType}
          nodeTypeLabel={
            d.nodeRole
              ? (labels.role?.[d.nodeRole] ?? d.nodeTypeLabel)
              : d.nodeTypeLabel
          }
          presentationColor={d.presentationColor}
          presentationHeight={d.presentationHeight}
          presentationOnly={presentationOnly}
          presentationWidth={d.presentationWidth}
          rollup={d.rollup ?? "none"}
          runtimeGateSummary={d.runtimeGateSummary}
          status={status}
          statusLabel={labels.node[status] ?? status}
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

// Presentational core shared by both modes: positions the topology (dagre +
// presentation overrides), draws the canvas, and overlays run status per node
// ONLY when given a status map. With `presentationOnly` it carries pure
// topology + presentation layout — no chips, no current-node ring.
function FlowGraphCanvas({
  topology,
  layout,
  labels,
  presentationOnly,
  statusByNode,
  currentStep,
}: {
  topology: GraphTopology;
  layout: Record<string, FlowLayoutOverride>;
  labels: FlowGraphViewLabels;
  presentationOnly: boolean;
  statusByNode?: RunNodeStatuses["nodes"];
  currentStep?: string | null;
}): ReactElement {
  const nodeTypes = useMemo<NodeTypes>(
    () => ({ flowNode: makeFlowNodeView(labels, presentationOnly) }),
    [labels, presentationOnly],
  );
  const edgeTypes = useMemo<EdgeTypes>(
    () => ({ flowEdge: makeFlowEdgeView(labels) }),
    [labels],
  );
  const positioned = useMemo(
    () => toFlowGraphView(topology, layout),
    [topology, layout],
  );

  const nodes = useMemo<Node[]>(
    () =>
      presentationOnly
        ? positioned.nodes
        : positioned.nodes.map((n) => ({
            ...n,
            data: {
              ...n.data,
              status: statusByNode?.[n.id]?.status ?? "Pending",
              isCurrent: n.id === currentStep,
              rollup: statusByNode?.[n.id]?.rollup ?? "none",
              runtimeGateSummary: statusByNode?.[n.id]?.gateSummary,
            },
          })),
    [positioned, presentationOnly, statusByNode, currentStep],
  );

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

// Run-coupled layer: lives ONLY when `runContext` is present, so the SSE
// subscription + /graph-status fetch + status state never exist in static mode.
function RunStatusLayer({
  topology,
  layout,
  labels,
  runContext,
}: {
  topology: GraphTopology;
  layout: Record<string, FlowLayoutOverride>;
  labels: FlowGraphViewLabels;
  runContext: FlowGraphRunContext;
}): ReactElement {
  const { runId, initialStatuses, currentStepId, runStatus } = runContext;

  const [statuses, setStatuses] = useState(initialStatuses);
  const [currentStep, setCurrentStep] = useState(currentStepId);
  const [liveRunStatus, setLiveRunStatus] = useState(runStatus);

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
    <FlowGraphCanvas
      currentStep={currentStep}
      labels={labels}
      layout={layout}
      presentationOnly={false}
      statusByNode={statuses}
      topology={topology}
    />
  );
}

export default function FlowGraphView({
  topology,
  layout,
  labels,
  runContext,
}: FlowGraphViewProps): ReactElement {
  if (runContext) {
    return (
      <RunStatusLayer
        labels={labels}
        layout={layout}
        runContext={runContext}
        topology={topology}
      />
    );
  }

  return (
    <FlowGraphCanvas
      labels={labels}
      layout={layout}
      presentationOnly={true}
      topology={topology}
    />
  );
}
