"use client";

import type {
  EvidenceNodeData,
  EvidenceTextLabels,
} from "@/lib/board/evidence-graph-layout";
import type { EvidenceGraph as EvidenceGraphData } from "@/lib/queries/evidence-graph";
import type { EvidenceNodeKind } from "@/lib/queries/evidence-graph";
import type { Node, NodeProps, NodeTypes } from "@xyflow/react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { Chip } from "@heroui/react";

import {
  kindLabel,
  layoutGraph,
  stateLabel,
  toFlowGraph,
} from "@/lib/board/evidence-graph-layout";

import "@xyflow/react/dist/style.css";

export interface EvidenceGraphLabels extends EvidenceTextLabels {
  title: string;
  empty: string;
  openPayload: string;
  payloadGone: string;
  payloadError: string;
  payloadLoading: string;
  close: string;
  filterNode: string;
  filterKind: string;
  filterState: string;
  filterAny: string;
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
    const openable = d.kind === "artifact" && Boolean(d.artifactId);

    function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!openable || !d.artifactId) return;
      event.preventDefault();
      d.onOpen?.(d.artifactId);
    }

    return (
      <div
        aria-label={openable ? `${labels.openPayload}: ${d.label}` : undefined}
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
            {d.label}
            {state ? ` · ${state}` : ""}
          </span>
        </Chip>
        <Handle position={Position.Right} type="source" />
      </div>
    );
  };
}

// Drop edges whose endpoints were removed by filtering (no dangling edges).
function filterGraph(
  graph: EvidenceGraphData,
  node: string | null,
  kind: string | null,
  state: string | null,
): EvidenceGraphData {
  const nodes = graph.nodes.filter((n) => {
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
  const router = useRouter();
  const searchParams = useSearchParams();

  const nodeFilter = searchParams.get("node");
  const kindFilter = searchParams.get("kind");
  const stateFilter = searchParams.get("state");

  const nodeOptions = useMemo(
    () => uniq(graph.nodes.map((n) => n.meta.nodeId as string | undefined)),
    [graph],
  );
  const kindOptions = useMemo(
    () => uniq(graph.nodes.map((n) => n.kind)),
    [graph],
  );
  const stateOptions = useMemo(
    () => uniq(graph.nodes.map((n) => n.state)),
    [graph],
  );

  const nodeTypes = useMemo<NodeTypes>(
    () => ({ evidence: makeEvidenceNodeView(labels) }),
    [labels],
  );

  const filtered = useMemo(
    () => filterGraph(graph, nodeFilter, kindFilter, stateFilter),
    [graph, nodeFilter, kindFilter, stateFilter],
  );

  const [payloadArtifactId, setPayloadArtifactId] = useState<string | null>(
    null,
  );

  const openArtifact = useCallback((artifactId: string) => {
    setPayloadArtifactId(artifactId);
  }, []);

  const { flowNodes, flowEdges } = useMemo(() => {
    const fg = toFlowGraph(filtered);
    const laidOut = layoutGraph(fg.nodes, fg.edges).map((n) => ({
      ...n,
      data: { ...n.data, onOpen: openArtifact },
    }));

    return { flowNodes: laidOut, flowEdges: fg.edges };
  }, [filtered, openArtifact]);

  const setFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());

      if (value) params.set(key, value);
      else params.delete(key);
      router.push(`?${params.toString()}`);
    },
    [router, searchParams],
  );

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const d = node.data as unknown as EvidenceNodeData;

      if (d.kind === "artifact" && d.artifactId) {
        openArtifact(d.artifactId);
      }
    },
    [openArtifact],
  );

  // Empty / task-input-only graph → just the empty hint.
  const meaningful = graph.nodes.filter((n) => n.kind !== "task-input");

  if (meaningful.length === 0) {
    return (
      <p
        className="rounded-[10px] border border-dashed border-line p-6 text-center font-mono text-[12px] text-mute"
        data-testid="evidence-empty"
      >
        {labels.empty}
      </p>
    );
  }

  const selectClass =
    "min-h-[30px] rounded-md border border-line bg-paper px-2 font-mono text-[11px] text-ink outline-none focus:border-amber";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
            {labels.filterNode}
          </span>
          <select
            aria-label={labels.filterNode}
            className={selectClass}
            value={nodeFilter ?? ""}
            onChange={(e) => setFilter("node", e.target.value)}
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
            onChange={(e) => setFilter("kind", e.target.value)}
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
            onChange={(e) => setFilter("state", e.target.value)}
          >
            <option value="">{labels.filterAny}</option>
            {stateOptions.map((o) => (
              <option key={o} value={o}>
                {stateLabel(o, labels)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className="h-[420px] w-full overflow-hidden rounded-[10px] border border-line bg-paper"
        data-testid="evidence-graph"
      >
        <ReactFlow
          fitView
          edges={flowEdges}
          elementsSelectable={true}
          nodeTypes={nodeTypes}
          nodes={flowNodes}
          nodesConnectable={false}
          nodesDraggable={false}
          onNodeClick={onNodeClick}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
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
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

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
