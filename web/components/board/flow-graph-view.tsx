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
import { buildFlowNodeTooltipsFromTopology } from "@/lib/flows/graph/node-tooltips";
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
  selectedNodeId?: string | null;
  nodeTooltips?: Record<string, string>;
  heightClassName?: string;
  onSelectNode?: (nodeId: string | null) => void;
}

interface FlowNodeBodyProps {
  label: string;
  // Typed node kind (ai_coding | judge | consensus | cli | check | human) → the colored
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
  selected?: boolean;
  tooltip?: string;
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

const NODE_TOOLTIP_MAX_ROWS = 5;
const NODE_TOOLTIP_MAX_LINE_CHARS = 120;
const NODE_TOOLTIP_ELLIPSIS = "...";

function formatCount(template: string | undefined, count: number): string {
  return (template ?? "$count").replace("$count", String(count));
}

function compactTooltipLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function truncateTooltipLine(line: string): string {
  const compactLine = compactTooltipLine(line);

  if (compactLine.length <= NODE_TOOLTIP_MAX_LINE_CHARS) {
    return compactLine;
  }

  const end = NODE_TOOLTIP_MAX_LINE_CHARS - NODE_TOOLTIP_ELLIPSIS.length;

  return `${compactLine.slice(0, end).trimEnd()}${NODE_TOOLTIP_ELLIPSIS}`;
}

function visibleTooltipRows(rows: readonly string[]): string[] {
  const visibleRows = rows
    .slice(0, NODE_TOOLTIP_MAX_ROWS)
    .map(truncateTooltipLine);
  const hiddenRowCount = rows.length - visibleRows.length;

  return hiddenRowCount > 0
    ? [...visibleRows, `+${hiddenRowCount}`]
    : visibleRows;
}

function tooltipPreview(text: string): {
  header: string | null;
  rows: string[];
} {
  const [header, ...rows] = text
    .split("\n")
    .map(compactTooltipLine)
    .filter((line) => line.length > 0);

  return {
    header: header ? truncateTooltipLine(header) : null,
    rows: visibleTooltipRows(rows),
  };
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
      className="rounded border border-line bg-ivory px-1.5 py-0.5 text-[10px] font-medium leading-none text-ink-2 shadow-sm"
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
  network: (
    <>
      <circle cx="4.5" cy="5" r="1.6" />
      <circle cx="11.5" cy="5" r="1.6" />
      <circle cx="8" cy="11" r="1.6" />
      <path d="M5.8 5.8 7 9.7" />
      <path d="M10.2 5.8 9 9.7" />
      <path d="M6.1 5h3.8" />
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
  sitemap: (
    <>
      <rect height="3" rx="0.6" width="4" x="6" y="2.5" />
      <rect height="3" rx="0.6" width="4" x="2.5" y="10.5" />
      <rect height="3" rx="0.6" width="4" x="9.5" y="10.5" />
      <path d="M8 5.5V8M4.5 8H11.5M4.5 8V10.5M11.5 8V10.5" />
    </>
  ),
  form: (
    <>
      <rect height="11" rx="1" width="9" x="3.5" y="2.5" />
      <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
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
  selected,
  tooltip,
  labels,
}: FlowNodeBodyProps): ReactElement {
  const declaredCount = declaredGateSummary?.total ?? 0;
  const runtimeGateCount = runtimeGateSummary?.total ?? 0;
  const blockingGateCount = runtimeGateSummary?.blockingTotal ?? 0;

  const typeVisual = nodeType ? nodeVisual(nodeType) : null;
  // Heym-style accent: a neutral elevated card carries the type hue in a TOP BAR +
  // the icon + a soft colored glow (the "colored shadow") — not a full border. The
  // author `presentationColor` (ADR-064) overrides the accent hue when set. The
  // current node glows brighter; others get a subtle colored lift off the canvas.
  const accent =
    presentationColor ??
    (typeVisual ? `var(--${typeVisual.colorToken})` : "var(--line)");
  const accented = Boolean(presentationColor || typeVisual);

  const cardStyle: {
    width?: number;
    height?: number;
    borderColor?: string;
    boxShadow?: string;
  } = { borderColor: accent };

  if (typeof presentationWidth === "number")
    cardStyle.width = presentationWidth;
  if (typeof presentationHeight === "number")
    cardStyle.height = presentationHeight;
  if (accented) {
    cardStyle.boxShadow = isCurrent
      ? `0 0 0 1.5px ${accent}, 0 10px 30px -6px color-mix(in srgb, ${accent} 75%, transparent)`
      : `0 6px 18px -10px color-mix(in srgb, ${accent} 55%, transparent)`;
  }
  if (selected) {
    const selectedShadow = `0 0 0 2px ${accent}, 0 0 30px 5px color-mix(in srgb, ${accent} 70%, transparent)`;

    cardStyle.boxShadow = cardStyle.boxShadow
      ? `${selectedShadow}, ${cardStyle.boxShadow}`
      : selectedShadow;
  }

  return (
    <div
      aria-current={isCurrent ? "step" : undefined}
      className="group relative"
      data-current={presentationOnly ? undefined : isCurrent ? "true" : "false"}
      data-node-role={nodeRole}
      data-node-status={presentationOnly ? undefined : status}
      data-selected={selected ? "true" : undefined}
      data-testid="flow-node"
      title={!tooltip && isCurrent ? labels.currentNode : undefined}
    >
      <div
        className="w-[200px] overflow-hidden rounded-[11px] border bg-ivory"
        style={cardStyle}
      >
        <div
          aria-hidden="true"
          data-testid="node-type-bar"
          style={{ height: 4, background: accent }}
        />
        <div className="flex flex-col gap-1 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              {typeVisual ? (
                <span
                  className="flex shrink-0 items-center"
                  data-node-type={nodeType}
                  data-testid="node-type-icon"
                  style={{ color: `var(--${typeVisual.colorToken})` }}
                  title={nodeTypeLabel}
                >
                  <NodeTypeIcon name={typeVisual.iconName} />
                </span>
              ) : null}
              {nodeTypeLabel ? (
                <span className="truncate text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
                  {nodeTypeLabel}
                </span>
              ) : null}
            </span>
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
          <p className="truncate text-[13.5px] font-semibold leading-tight text-ink">
            {displayLabel ?? label}
          </p>
          {declaredCount > 0 ||
          runtimeGateCount > 0 ||
          blockingGateCount > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 overflow-hidden text-[10px] leading-tight text-ink-2">
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
          ) : null}
        </div>
      </div>
      {rollup === "failed" || rollup === "stale" ? (
        <span data-rollup={rollup} data-testid="gate-rollup" />
      ) : null}
      {tooltip ? <NodeTooltipCard text={tooltip} /> : null}
    </div>
  );
}

// Styled hover/focus tooltip card (replaces the native `title=`): the node
// tooltip builders emit a `\n`-joined block — first line is the `id · type`
// header, the rest are `key: value` facts (model/permission/workspace/skills/
// mcps/rework) or `N transitions`/`N gates` counts. Revealed via the parent
// node's `group` on hover/focus; pointer-events-none so it never eats clicks.
function NodeTooltipCard({ text }: { text: string }): ReactElement {
  const { header, rows } = tooltipPreview(text);

  return (
    <div
      className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 hidden max-h-[220px] w-[260px] max-w-[260px] -translate-x-1/2 flex-col gap-1 overflow-hidden rounded-lg border border-line bg-paper p-2.5 text-left shadow-[var(--shadow-lg)] group-hover:flex group-focus-within:flex"
      data-testid="flow-node-tooltip"
      role="tooltip"
    >
      {header ? (
        <span className="block max-w-full truncate font-mono text-[10.5px] font-semibold text-ink">
          {header}
        </span>
      ) : null}
      {rows.map((row, index) => {
        const sep = row.indexOf(": ");

        if (sep <= 0) {
          return (
            <span
              key={index}
              className="line-clamp-2 max-w-full break-words font-mono text-[10px] text-mute [overflow-wrap:anywhere]"
            >
              {row}
            </span>
          );
        }

        return (
          <span
            key={index}
            className="flex max-w-full min-w-0 gap-1 overflow-hidden text-[10px] leading-snug"
          >
            <span className="max-w-[82px] shrink-0 truncate font-mono font-semibold uppercase tracking-[0.08em] text-mute">
              {row.slice(0, sep)}
            </span>
            <span className="line-clamp-3 min-w-0 break-words text-ink-2 [overflow-wrap:anywhere]">
              {row.slice(sep + 2)}
            </span>
          </span>
        );
      })}
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
  selected?: boolean;
  tooltip?: string;
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
          selected={d.selected ?? false}
          status={status}
          statusLabel={labels.node[status] ?? status}
          tooltip={d.tooltip}
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
    const dotColor =
      typeof style?.stroke === "string" ? style.stroke : "var(--edge-success)";

    return (
      <>
        <BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
        {/* Flowing particle along the edge (Heym-style motion); static under SSR. */}
        <circle data-testid="flow-edge-dot" fill={dotColor} r="2.6">
          <animateMotion dur="2.6s" path={edgePath} repeatCount="indefinite" />
        </circle>
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
  selectedNodeId,
  nodeTooltips,
  heightClassName = "h-[420px]",
  onSelectNode,
}: {
  topology: GraphTopology;
  layout: Record<string, FlowLayoutOverride>;
  labels: FlowGraphViewLabels;
  presentationOnly: boolean;
  statusByNode?: RunNodeStatuses["nodes"];
  currentStep?: string | null;
  selectedNodeId?: string | null;
  nodeTooltips?: Record<string, string>;
  heightClassName?: string;
  onSelectNode?: (nodeId: string | null) => void;
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
  const topologyTooltips = useMemo(
    () => buildFlowNodeTooltipsFromTopology(topology),
    [topology],
  );

  const nodes = useMemo<Node[]>(
    () =>
      positioned.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          ...(presentationOnly
            ? {}
            : {
                status: statusByNode?.[n.id]?.status ?? "Pending",
                isCurrent: n.id === currentStep,
                rollup: statusByNode?.[n.id]?.rollup ?? "none",
                runtimeGateSummary: statusByNode?.[n.id]?.gateSummary,
              }),
          selected: n.id === selectedNodeId,
          tooltip: nodeTooltips?.[n.id] ?? topologyTooltips[n.id],
        },
      })),
    [
      positioned,
      presentationOnly,
      statusByNode,
      currentStep,
      selectedNodeId,
      nodeTooltips,
      topologyTooltips,
    ],
  );

  return (
    <div
      className={`${heightClassName} w-full overflow-hidden rounded-[10px] border border-line bg-paper`}
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
        onNodeClick={
          onSelectNode ? (_event, node) => onSelectNode(node.id) : undefined
        }
        onPaneClick={onSelectNode ? () => onSelectNode(null) : undefined}
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
  nodeTooltips,
  heightClassName,
}: {
  topology: GraphTopology;
  layout: Record<string, FlowLayoutOverride>;
  labels: FlowGraphViewLabels;
  runContext: FlowGraphRunContext;
  nodeTooltips?: Record<string, string>;
  heightClassName?: string;
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
      heightClassName={heightClassName}
      labels={labels}
      layout={layout}
      nodeTooltips={nodeTooltips}
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
  selectedNodeId,
  nodeTooltips,
  heightClassName,
  onSelectNode,
}: FlowGraphViewProps): ReactElement {
  if (runContext) {
    return (
      <RunStatusLayer
        heightClassName={heightClassName}
        labels={labels}
        layout={layout}
        nodeTooltips={nodeTooltips}
        runContext={runContext}
        topology={topology}
      />
    );
  }

  return (
    <FlowGraphCanvas
      heightClassName={heightClassName}
      labels={labels}
      layout={layout}
      nodeTooltips={nodeTooltips}
      presentationOnly={true}
      selectedNodeId={selectedNodeId}
      topology={topology}
      onSelectNode={onSelectNode}
    />
  );
}
