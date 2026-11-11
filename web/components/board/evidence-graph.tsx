"use client";

import type {
  EvidenceNodeData,
  EvidenceTextLabels,
} from "@/lib/board/evidence-graph-layout";
import type { EvidenceGraph as EvidenceGraphData } from "@/lib/queries/evidence-graph";
import type { EvidenceNodeKind } from "@/lib/queries/evidence-graph";
import type { Edge, Node, NodeProps, NodeTypes, Viewport } from "@xyflow/react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  RefObject,
} from "react";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Background, Handle, Position, ReactFlow } from "@xyflow/react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Button, Chip } from "@heroui/react";

import {
  artifactKindLabel,
  kindLabel,
  layoutGraph,
  stateLabel,
  toFlowGraph,
} from "@/lib/board/evidence-graph-layout";
import {
  GRAPH_MIN_ZOOM,
  GraphViewportControls,
  useGraphViewportLabels,
} from "@/components/graphs/graph-viewport-controls";
import { useTheme } from "@/lib/theme";
import { useLatestRef } from "@/lib/use-latest-ref";

import "@xyflow/react/dist/style.css";

export interface EvidenceGraphLabels extends EvidenceTextLabels {
  title: string;
  empty: string;
  noMatches: string;
  clearFilters: string;
  openPayload: string;
  payloadGone: string;
  payloadError: string;
  payloadLoading: string;
  close: string;
  filterNode: string;
  filterKind: string;
  filterState: string;
  filterAny: string;
  filterItem: string;
}

export interface EvidenceGraphProps {
  runId: string;
  graph: EvidenceGraphData;
  labels: EvidenceGraphLabels;
}

type ChipColor = "default" | "success" | "warning" | "danger" | "accent";

function colorForState(state: string | null): ChipColor {
  switch (state) {
    case "current":
    case "passed":
    case "Succeeded":
      return "success";
    case "stale":
      return "warning";
    case "failed":
    case "Failed":
      return "danger";
    case "superseded":
    case "skipped":
      return "default";
    default:
      return "accent";
  }
}

// The node click flow lives in the parent (onNodeClick), but keyboard users
// need a focusable element on the node itself. The parent threads `onOpen`
// through node data so Enter/Space invoke the same open-payload path.
type EvidenceNodeRenderData = EvidenceNodeData & {
  onOpen?: (artifactId: string) => void;
};

// A nodeType render fn that closes over the translation labels. The chip shows
// the server-side human label plus the translated state (when one maps), so an
// RU user reads localized text rather than raw enum tokens.
function makeEvidenceNodeView(
  labels: EvidenceGraphLabels,
): (props: NodeProps) => ReactElement {
  return function EvidenceNodeView({ data }: NodeProps): ReactElement {
    const d = data as unknown as EvidenceNodeRenderData;
    const state = stateLabel(d.state, labels);
    // An artifact node's label IS its artifact kind token (evidence DTO);
    // translate catalog-mapped kinds (M29: mutation_report) for RU users.
    const label =
      d.kind === "artifact" ? artifactKindLabel(d.label, labels) : d.label;
    const openable = d.kind === "artifact" && Boolean(d.artifactId);

    function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!openable || !d.artifactId) return;
      event.preventDefault();
      d.onOpen?.(d.artifactId);
    }

    return (
      <div
        aria-label={openable ? `${labels.openPayload}: ${label}` : undefined}
        className="relative cursor-pointer"
        data-artifact-id={d.artifactId ?? undefined}
        data-kind={d.kind}
        data-state={d.state ?? undefined}
        data-testid="evidence-node"
        role={openable ? "button" : undefined}
        tabIndex={openable ? 0 : undefined}
        onKeyDown={openable ? onKeyDown : undefined}
      >
        <Handle position={Position.Left} type="target" />
        <Chip color={colorForState(d.state)} size="sm" variant="soft">
          <span className="font-mono text-[11px]">
            {label}
            {state ? ` · ${state}` : ""}
          </span>
        </Chip>
        <Handle position={Position.Right} type="source" />
      </div>
    );
  };
}

type EvidenceFilter = "node" | "kind" | "state" | "evidenceItem";

// Drop edges whose endpoints were removed by filtering (no dangling edges).
function filterGraph(
  graph: EvidenceGraphData,
  { node, kind, state, evidenceItem }: Record<EvidenceFilter, string | null>,
): EvidenceGraphData {
  const nodes = graph.nodes.filter((n) => {
    if (evidenceItem && n.id !== evidenceItem) return false;
    if (node && n.meta.nodeId !== node && n.id !== node) return false;
    if (kind && n.kind !== kind) return false;
    if (state && n.state !== state) return false;

    return true;
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  return { nodes, edges };
}

function uniq(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
}

export default function EvidenceGraph({
  runId,
  graph,
  labels,
}: EvidenceGraphProps): ReactElement {
  const searchParams = useSearchParams();

  const nodeFilter = searchParams.get("node") || null;
  const kindFilter = searchParams.get("kind") || null;
  const stateFilter = searchParams.get("state") || null;
  const evidenceItem = searchParams.get("evidenceItem") || null;
  const filterKey = JSON.stringify([
    nodeFilter,
    kindFilter,
    stateFilter,
    evidenceItem,
  ]);
  const hasFilters = Boolean(
    nodeFilter || kindFilter || stateFilter || evidenceItem,
  );
  const hasEvidence = graph.nodes.some((node) => node.kind !== "task-input");
  const selectedItem = evidenceItem
    ? graph.nodes.find((node) => node.id === evidenceItem)
    : undefined;
  const selectedItemLabel =
    selectedItem?.kind === "artifact"
      ? artifactKindLabel(selectedItem.label, labels)
      : selectedItem?.label;

  const nodeOptions = useMemo(
    () =>
      uniq([
        nodeFilter,
        ...graph.nodes.map((node) => node.meta.nodeId as string | undefined),
      ]),
    [graph, nodeFilter],
  );
  const kindOptions = useMemo(
    () => uniq([kindFilter, ...graph.nodes.map((node) => node.kind)]),
    [graph, kindFilter],
  );
  const stateOptions = useMemo(
    () => uniq([stateFilter, ...graph.nodes.map((node) => node.state)]),
    [graph, stateFilter],
  );

  const nodeTypes = useMemo<NodeTypes>(
    () => ({ evidence: makeEvidenceNodeView(labels) }),
    [labels],
  );

  const filtered = useMemo(
    () =>
      filterGraph(graph, {
        node: nodeFilter,
        kind: kindFilter,
        state: stateFilter,
        evidenceItem,
      }),
    [graph, nodeFilter, kindFilter, stateFilter, evidenceItem],
  );

  const [payloadArtifactId, setPayloadArtifactId] = useState<string | null>(
    null,
  );

  const openArtifact = useCallback((artifactId: string) => {
    setPayloadArtifactId(artifactId);
  }, []);

  const { flowNodes, flowEdges } = useMemo(() => {
    const fg = toFlowGraph(filtered);
    const laidOut: Node[] = layoutGraph(fg.nodes, fg.edges).map((n) => ({
      ...n,
      data: { ...n.data, onOpen: openArtifact },
    }));

    return { flowNodes: laidOut, flowEdges: fg.edges };
  }, [filtered, openArtifact]);

  function setFilters(changes: Partial<Record<EvidenceFilter, string>>): void {
    // Read the current address so consecutive changes compose before React commits.
    const url = new URL(window.location.href);

    for (const [key, value] of Object.entries(changes)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.pushState(null, "", url);
  }

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const d = node.data as unknown as EvidenceNodeData;

      if (d.kind === "artifact" && d.artifactId) {
        openArtifact(d.artifactId);
      }
    },
    [openArtifact],
  );

  const selectClass =
    "min-h-[30px] rounded-md border border-line bg-paper px-2 font-mono text-[11px] text-ink outline-none focus:border-amber";

  return (
    <div className="flex flex-col gap-3">
      <div
        className={
          hasEvidence || hasFilters
            ? "flex flex-wrap items-center gap-2"
            : "hidden"
        }
      >
        <label className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
            {labels.filterNode}
          </span>
          <select
            aria-label={labels.filterNode}
            className={selectClass}
            value={nodeFilter ?? ""}
            onChange={(event) => setFilters({ node: event.target.value })}
          >
            <option value="">{labels.filterAny}</option>
            {nodeOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
            {labels.filterKind}
          </span>
          <select
            aria-label={labels.filterKind}
            className={selectClass}
            value={kindFilter ?? ""}
            onChange={(event) => setFilters({ kind: event.target.value })}
          >
            <option value="">{labels.filterAny}</option>
            {kindOptions.map((o) => (
              <option key={o} value={o}>
                {kindLabel(o as EvidenceNodeKind, labels)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
            {labels.filterState}
          </span>
          <select
            aria-label={labels.filterState}
            className={selectClass}
            value={stateFilter ?? ""}
            onChange={(event) => setFilters({ state: event.target.value })}
          >
            <option value="">{labels.filterAny}</option>
            {stateOptions.map((o) => (
              <option key={o} value={o}>
                {stateLabel(o, labels)}
              </option>
            ))}
          </select>
        </label>
        {evidenceItem ? (
          <span className="max-w-full break-words rounded border border-line px-2 py-1 font-mono text-xs text-ink">
            {labels.filterItem}
            {selectedItemLabel ? ` · ${selectedItemLabel}` : ""}
          </span>
        ) : null}
        {hasFilters ? (
          <Button
            size="sm"
            variant="outline"
            onPress={() =>
              setFilters({ node: "", kind: "", state: "", evidenceItem: "" })
            }
          >
            <XMarkIcon aria-hidden="true" className="size-3" />
            {labels.clearFilters}
          </Button>
        ) : null}
      </div>

      <div
        className={
          hasEvidence || hasFilters
            ? "h-[420px] w-full overflow-hidden rounded-[10px] border border-line bg-paper"
            : "rounded-[10px] border border-dashed border-line font-mono text-[12px]"
        }
        data-testid="evidence-graph"
      >
        <EvidenceResults
          key={filterKey}
          edges={flowEdges}
          emptyMessage={hasFilters ? labels.noMatches : labels.empty}
          labels={labels}
          nodeTypes={nodeTypes}
          nodes={hasEvidence ? flowNodes : []}
          onNodeClick={onNodeClick}
        />
      </div>

      {payloadArtifactId ? (
        <PayloadModal
          artifactId={payloadArtifactId}
          labels={labels}
          runId={runId}
          onClose={() => setPayloadArtifactId(null)}
        />
      ) : null}
    </div>
  );
}

type EvidenceCanvasProps = {
  nodes: Node[];
  edges: Edge[];
  labels: EvidenceGraphLabels;
  nodeTypes: NodeTypes;
  onNodeClick: (event: unknown, node: Node) => void;
};

function EvidenceResults({
  emptyMessage,
  ...canvas
}: EvidenceCanvasProps & { emptyMessage: string }): ReactElement {
  // The filter tuple owns the camera even when live data leaves no nodes to fit.
  const cameraRef = useRef<Viewport | null>(null);

  if (canvas.nodes.length === 0) {
    return (
      <p
        className="p-6 text-center text-mute"
        data-testid="evidence-empty"
        role="status"
      >
        {emptyMessage}
      </p>
    );
  }

  return <EvidenceCanvas {...canvas} cameraRef={cameraRef} />;
}

function EvidenceCanvas({
  cameraRef,
  nodes,
  edges,
  labels,
  nodeTypes,
  onNodeClick,
}: EvidenceCanvasProps & {
  cameraRef: RefObject<Viewport | null>;
}): ReactElement {
  const viewportLabels = useGraphViewportLabels();
  const { resolvedTheme } = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const displayedNodes = useMemo(
    () => nodes.map((node) => ({ ...node, selected: node.id === selectedId })),
    [nodes, selectedId],
  );

  function selectNode(event: unknown, node: Node): void {
    setSelectedId(node.id);
    onNodeClick(event, node);
  }

  return (
    <ReactFlow
      ariaLabelConfig={viewportLabels}
      colorMode={resolvedTheme}
      edges={edges}
      minZoom={GRAPH_MIN_ZOOM}
      nodeTypes={nodeTypes}
      nodes={displayedNodes}
      nodesConnectable={false}
      nodesDraggable={false}
      onMoveEnd={(event, next) => {
        if (event || cameraRef.current) cameraRef.current = next;
      }}
      onNodeClick={selectNode}
      onPaneClick={() => setSelectedId(null)}
    >
      <Background />
      <GraphViewportControls
        cameraRef={cameraRef}
        nodes={nodes.map((node) => {
          const data = node.data as unknown as EvidenceNodeData;
          const label =
            data.kind === "artifact"
              ? artifactKindLabel(data.label, labels)
              : data.label;
          const definition = data.meta.defId;

          return {
            id: node.id,
            label:
              typeof definition === "string"
                ? `${label} · ${definition}`
                : label,
          };
        })}
        onLocate={(id) => {
          const node = nodes.find((candidate) => candidate.id === id);

          if (node) selectNode(null, node);
        }}
      />
    </ReactFlow>
  );
}

function PayloadModal({
  runId,
  artifactId,
  labels,
  onClose,
}: {
  runId: string;
  artifactId: string;
  labels: EvidenceGraphLabels;
  onClose: () => void;
}): ReactElement {
  const [body, setBody] = useState<string>(labels.payloadLoading);

  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useLatestRef(onClose);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      setBody(labels.payloadLoading);

      try {
        const res = await fetch(
          `/api/runs/${runId}/artifacts/${artifactId}/payload`,
        );

        if (res.status === 410) {
          if (!cancelled) setBody(labels.payloadGone);

          return;
        }

        if (!res.ok) {
          if (!cancelled) setBody(labels.payloadError);

          return;
        }

        const text = await res.text();

        if (!cancelled) setBody(text);
      } catch {
        if (!cancelled) setBody(labels.payloadError);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [
    runId,
    artifactId,
    labels.payloadLoading,
    labels.payloadGone,
    labels.payloadError,
  ]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={labels.close}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="evidence-payload-title"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[680px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 truncate font-mono text-[13px] font-bold tracking-[-0.01em] text-ink"
            id="evidence-payload-title"
          >
            {labels.openPayload}
          </h2>
          <button
            aria-label={labels.close}
            className="font-mono text-[14px] text-mute hover:text-ink"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto overscroll-contain px-5 py-5">
          <pre
            aria-live="polite"
            className="max-h-[420px] overflow-auto rounded-[6px] border border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-ivory p-3 font-mono text-[11px] leading-[1.5] text-ink-2"
            data-testid="artifact-payload"
            role="status"
          >
            {body}
          </pre>
        </div>
      </div>
    </div>
  );
}
