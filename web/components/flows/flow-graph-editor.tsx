"use client";

import type { FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import type { EditorValidationSummaryLabels } from "@/components/flows/editor-validation-summary";
import type {
  NodePresentationStyle,
  NodeSideFormLabels,
} from "@/components/flows/node-form/node-side-form";
import type { FlowNodeData } from "@/lib/board/flow-graph-view-layout";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { GateKind, NodeType } from "@/lib/flows/editor/editor-state";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { DeclaredGateSummary } from "@/lib/queries/flow-graph-view";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type {
  Connection,
  Edge,
  Node,
  NodeProps,
  NodeTypes,
} from "@xyflow/react";
import type { ReactElement } from "react";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";

import { FlowNodeBody } from "@/components/board/flow-graph-view";
import { EditorValidationSummary } from "@/components/flows/editor-validation-summary";
import {
  EdgeConnectModal,
  type EdgeConnectModalLabels,
} from "@/components/flows/edge-connect-modal";
import { NodeSideForm } from "@/components/flows/node-form/node-side-form";
import { toFlowGraphView } from "@/lib/board/flow-graph-view-layout";
import {
  addGate,
  addNode,
  moveNode,
  outcomeExistsForSource,
  removeNode,
  replaceNode,
  setTransition,
} from "@/lib/flows/editor/editor-state";
import { readPresentation } from "@/lib/flows/editor/manifest-io";
import { GATE_KINDS, NODE_TYPES } from "@/lib/flows/editor/node-form";
import { validateEditorManifest } from "@/lib/flows/editor/validation";

import "@xyflow/react/dist/style.css";

export type FlowEditorToolbarLabels = {
  addNode: string;
  removeNode: string;
  addGate: string;
  selectNodeHint: string;
  nodeType: Record<NodeType, string>;
  gateKind: Record<GateKind, string>;
};

export type FlowGraphEditorLabels = FlowEditorToolbarLabels & {
  graph: FlowGraphViewLabels;
  nodeForm: NodeSideFormLabels;
  validation: EditorValidationSummaryLabels;
  edgeModal: EdgeConnectModalLabels;
};

export interface FlowGraphEditorProps {
  initialManifest: FlowYamlV1;
  topology: GraphTopology;
  layout: FlowLayout;
  draftVersion: number;
  labels: FlowGraphEditorLabels;
  onChange?: (next: { manifest: FlowYamlV1; draftVersion: number }) => void;
  onSelectNode?: (nodeId: string | null) => void;
}

const EMPTY_GATE_SUMMARY: DeclaredGateSummary = {
  total: 0,
  blocking: 0,
  advisory: 0,
  kinds: [],
};

function debugLog(op: string): void {
  if (process.env.NODE_ENV === "production") return;

  // eslint-disable-next-line no-console
  console.debug(`[flow-editor] ${op}`);
}

// Toolbar — presentational, provider-free (no ReactFlow/Handle), so it renders
// under renderToStaticMarkup without canvas context. The data attributes are
// the test/e2e contract surface; mirrors the FlowNodeBody convention.
export function FlowEditorToolbar({
  labels,
  selectedNodeId,
  onAddNode,
  onRemoveNode,
  onAddGate,
}: {
  labels: FlowEditorToolbarLabels;
  selectedNodeId: string | null;
  onAddNode: (type: NodeType) => void;
  onRemoveNode: () => void;
  onAddGate: (kind: GateKind) => void;
}): ReactElement {
  const hasSelection = selectedNodeId !== null;
  const disabledAttr = hasSelection ? "false" : "true";

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-paper px-3 py-2"
      data-testid="flow-editor-toolbar"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
          {labels.addNode}
        </span>
        {NODE_TYPES.map((type) => (
          <button
            key={type}
            className="rounded-md border border-line bg-ivory px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
            data-testid={`add-node-${type}`}
            type="button"
            onClick={() => onAddNode(type)}
          >
            {labels.nodeType[type]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
          {labels.addGate}
        </span>
        {GATE_KINDS.map((kind) => (
          <button
            key={kind}
            className="rounded-md border border-line bg-ivory px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper disabled:opacity-50"
            data-disabled={disabledAttr}
            data-testid={`add-gate-${kind}`}
            disabled={!hasSelection}
            type="button"
            onClick={() => onAddGate(kind)}
          >
            {labels.gateKind[kind]}
          </button>
        ))}
        {hasSelection ? null : (
          <span className="font-mono text-[10px] text-mute">
            {labels.selectNodeHint}
          </span>
        )}
      </div>

      <button
        className="ml-auto rounded-md border border-line px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:bg-paper disabled:opacity-50"
        data-disabled={disabledAttr}
        data-testid="remove-node"
        disabled={!hasSelection}
        type="button"
        onClick={onRemoveNode}
      >
        {labels.removeNode}
      </button>
    </div>
  );
}

// Canvas node view: reuse the read-only presentational body wrapped with the
// source/target handles the canvas needs to draw + rewire transition edges.
// The editor has no run, so status is neutral and the chip surfaces the node
// type rather than a runtime status.
function makeEditorNodeView(
  labels: FlowGraphViewLabels,
): (props: NodeProps) => ReactElement {
  return function EditorNodeView({ data }: NodeProps): ReactElement {
    const d = data as unknown as FlowNodeData;

    return (
      <>
        <Handle position={Position.Left} type="target" />
        <FlowNodeBody
          declaredGateSummary={d.declaredGateSummary}
          displayLabel={d.displayLabel}
          isCurrent={false}
          label={d.label}
          labels={labels}
          nodeRole={d.nodeRole}
          nodeType={d.nodeType}
          nodeTypeLabel={d.nodeTypeLabel}
          presentationColor={d.presentationColor}
          presentationHeight={d.presentationHeight}
          presentationWidth={d.presentationWidth}
          rollup="none"
          status="Pending"
          statusLabel={d.nodeTypeLabel}
        />
        <Handle position={Position.Right} type="source" />
      </>
    );
  };
}

function nextNodeId(manifest: FlowYamlV1, type: NodeType): string {
  const existing = new Set((manifest.nodes ?? []).map((n) => n.id));
  let i = 1;

  while (existing.has(`${type}_${i}`)) i += 1;

  return `${type}_${i}`;
}

function nextGateId(
  manifest: FlowYamlV1,
  nodeId: string,
  kind: GateKind,
): string {
  const node = (manifest.nodes ?? []).find((n) => n.id === nodeId);
  const existing = new Set((node?.pre_finish?.gates ?? []).map((g) => g.id));
  let i = 1;

  while (existing.has(`${kind}_${i}`)) i += 1;

  return `${kind}_${i}`;
}

// Deterministic spawn position for a freshly added node, indexed off the current
// node count. Shared by the canvas node AND the manifest presentation write so a
// new node's position survives serialize→reload (audit b).
function spawnPosition(index: number): { x: number; y: number } {
  return { x: 80 + (index % 4) * 60, y: 60 + Math.floor(index / 4) * 90 };
}

function editorCanvasNode(
  id: string,
  type: NodeType,
  nodeTypeLabel: string,
  pos: { x: number; y: number },
): Node {
  const data: FlowNodeData = {
    label: id,
    nodeType: type,
    displayLabel: id,
    nodeTypeLabel,
    // Fresh nodes carry no resolved role/gates; the body tolerates this.
    nodeRole: "other" as FlowNodeData["nodeRole"],
    declaredGateSummary: EMPTY_GATE_SUMMARY,
  };

  return {
    id,
    type: "flowNode",
    position: pos,
    data: data as unknown as Record<string, unknown>,
  };
}

// Outcomes that loop the graph BACKWARD (rework/takeover/reject) read as dashed +
// amber; forward outcomes (success/failure/…) stay solid. Mirrors the read-only
// `edgeAnimated`/`edgeClassName` roles, keyed off the editor's free-text outcome.
const BACK_EDGE_OUTCOMES = new Set(["rework", "takeover", "reject"]);

export function isBackEdgeOutcome(outcome: string): boolean {
  return BACK_EDGE_OUTCOMES.has(outcome.trim().toLowerCase());
}

export type EditorEdgeStyle = {
  animated: boolean;
  style: { stroke: string; strokeDasharray?: string };
};

// Pure edge-style map (T1.2): outcome → { animated, stroke[, dash] }. Back-edges
// animate + dash in the warm `--attention` amber; forward edges are a solid muted
// stroke. Tested directly (no canvas render needed).
export function editorEdgeStyle(outcome: string): EditorEdgeStyle {
  if (isBackEdgeOutcome(outcome)) {
    return {
      animated: true,
      style: { stroke: "var(--attention)", strokeDasharray: "6 4" },
    };
  }

  return { animated: false, style: { stroke: "var(--mute-2)" } };
}

// Convert the read-only view's custom `flowEdge`-typed edges to default edges
// carrying the outcome as a visible label + the outcome-derived style (T1.2).
function toEditorEdges(edges: Edge[]): Edge[] {
  return edges.map((e) => {
    const data = e.data as
      | { displayLabel?: string; outcome?: string }
      | undefined;
    const outcome = data?.outcome ?? "";
    const { animated, style } = editorEdgeStyle(outcome);

    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: data?.displayLabel ?? data?.outcome ?? "",
      animated,
      style,
      ...(isBackEdgeOutcome(outcome)
        ? { labelStyle: { fill: "var(--attention)" } }
        : {}),
    };
  });
}

function upsertEdge(
  edges: Edge[],
  source: string,
  target: string,
  outcome: string,
): Edge[] {
  const id = `${source}:${outcome}`;
  const without = edges.filter((e) => e.id !== id);
  const { animated, style } = editorEdgeStyle(outcome);

  return [
    ...without,
    {
      id,
      source,
      target,
      label: outcome,
      animated,
      style,
      ...(isBackEdgeOutcome(outcome)
        ? { labelStyle: { fill: "var(--attention)" } }
        : {}),
    },
  ];
}

function bumpDeclaredGate(node: Node): Node {
  const data = node.data as unknown as FlowNodeData;
  const prev = data.declaredGateSummary ?? EMPTY_GATE_SUMMARY;
  const nextData: FlowNodeData = {
    ...data,
    declaredGateSummary: { ...prev, total: prev.total + 1 },
  };

  return { ...node, data: nextData as unknown as Record<string, unknown> };
}

export default function FlowGraphEditor({
  initialManifest,
  topology,
  layout,
  draftVersion,
  labels,
  onChange,
  onSelectNode,
}: FlowGraphEditorProps): ReactElement {
  const seeded = useMemo(
    () => toFlowGraphView(topology, layout),
    [topology, layout],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(seeded.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    toEditorEdges(seeded.edges),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<FlowYamlV1>(initialManifest);
  const [pendingConnection, setPendingConnection] = useState<{
    source: string;
    target: string;
  } | null>(null);
  const [pendingOutcome, setPendingOutcome] = useState("success");

  const manifestRef = useRef<FlowYamlV1>(initialManifest);

  const nodeTypes = useMemo<NodeTypes>(
    () => ({ flowNode: makeEditorNodeView(labels.graph) }),
    [labels.graph],
  );

  const applyManifest = useCallback(
    (fn: (m: FlowYamlV1) => FlowYamlV1, op: string): void => {
      const next = fn(manifestRef.current);

      manifestRef.current = next;
      setManifest(next);
      debugLog(op);
      onChange?.({ manifest: next, draftVersion });
    },
    [onChange, draftVersion],
  );

  const select = useCallback(
    (id: string | null): void => {
      setSelectedNodeId(id);
      onSelectNode?.(id);
    },
    [onSelectNode],
  );

  const handleAddNode = useCallback(
    (type: NodeType): void => {
      const id = nextNodeId(manifestRef.current, type);
      const pos = spawnPosition(manifestRef.current.nodes?.length ?? 0);

      applyManifest((m) => addNode(m, type, id, pos), `add-node:${id}`);
      setNodes((nds) => [
        ...nds,
        editorCanvasNode(id, type, labels.nodeType[type], pos),
      ]);
      select(id);
    },
    [applyManifest, labels.nodeType, select, setNodes],
  );

  const handleRemoveNode = useCallback((): void => {
    if (selectedNodeId === null) return;

    const id = selectedNodeId;

    applyManifest((m) => removeNode(m, id), `remove-node:${id}`);
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    select(null);
  }, [applyManifest, selectedNodeId, setNodes, setEdges, select]);

  const handleAddGate = useCallback(
    (kind: GateKind): void => {
      if (selectedNodeId === null) return;

      const id = selectedNodeId;
      const gateId = nextGateId(manifestRef.current, id, kind);

      applyManifest(
        (m) => addGate(m, id, kind, gateId),
        `add-gate:${id}:${gateId}`,
      );
      setNodes((nds) =>
        nds.map((n) => (n.id === id ? bumpDeclaredGate(n) : n)),
      );
    },
    [applyManifest, selectedNodeId, setNodes],
  );

  // A new connection opens the typed-edge modal (D7); the edge is written ONLY
  // on confirm, through the same setTransition→applyManifest path the side-form
  // uses. Cancel adds no edge.
  const handleConnect = useCallback((conn: Connection): void => {
    if (!conn.source || !conn.target) return;

    setPendingConnection({ source: conn.source, target: conn.target });
    setPendingOutcome("success");
  }, []);

  const confirmConnection = useCallback(
    (outcome: string): void => {
      if (pendingConnection === null) return;

      const { source, target } = pendingConnection;

      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.debug("[flowEditor] connect", { source, target, outcome });
      }

      applyManifest(
        (m) => setTransition(m, source, outcome, target),
        `rewire:${source}->${target}`,
      );
      setEdges((eds) => upsertEdge(eds, source, target, outcome));
      setPendingConnection(null);
    },
    [applyManifest, pendingConnection, setEdges],
  );

  const cancelConnection = useCallback((): void => {
    setPendingConnection(null);
  }, []);

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]): void => {
      onNodesChange(changes);
      for (const ch of changes) {
        if (ch.type === "position" && ch.dragging === false && ch.position) {
          const pos = ch.position;

          applyManifest(
            (m) => moveNode(m, ch.id, { x: pos.x, y: pos.y }),
            `move:${ch.id}`,
          );
        }
      }
    },
    [onNodesChange, applyManifest],
  );

  const handleNodeFormChange = useCallback(
    (next: NonNullable<FlowYamlV1["nodes"]>[number]): void => {
      if (selectedNodeId === null) return;

      applyManifest(
        (m) => replaceNode(m, selectedNodeId, next),
        `edit-node:${selectedNodeId}`,
      );
    },
    [applyManifest, selectedNodeId],
  );

  // Side-form width/height/color edits merge into the node's presentation entry
  // through the SAME moveNode merge as drag, so x/y are carried from the live
  // canvas position. The canvas node's data + dims are patched in lockstep so the
  // box repaints without a reseed.
  const handlePresentationChange = useCallback(
    (patch: NodePresentationStyle): void => {
      if (selectedNodeId === null) return;

      const id = selectedNodeId;
      const canvasNode = nodes.find((n) => n.id === id);
      const pos = canvasNode?.position ?? { x: 0, y: 0 };
      const existing = readPresentation(manifestRef.current).find(
        (p) => p.id === id,
      );

      const width =
        "width" in patch ? patch.width : (existing?.width ?? undefined);
      const height =
        "height" in patch ? patch.height : (existing?.height ?? undefined);
      const color =
        "color" in patch ? patch.color : (existing?.color ?? undefined);

      applyManifest(
        (m) =>
          moveNode(m, id, {
            x: pos.x,
            y: pos.y,
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            ...(color !== undefined ? { color } : {}),
          }),
        `presentation:${id}`,
      );
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
                ...n,
                ...(width !== undefined ? { width } : {}),
                ...(height !== undefined ? { height } : {}),
                data: {
                  ...n.data,
                  presentationWidth: width,
                  presentationHeight: height,
                  presentationColor: color,
                },
              }
            : n,
        ),
      );
    },
    [applyManifest, nodes, selectedNodeId, setNodes],
  );

  const selectedNode =
    selectedNodeId === null
      ? null
      : (manifest.nodes?.find((nd) => nd.id === selectedNodeId) ?? null);

  const selectedPresentation =
    selectedNodeId === null
      ? undefined
      : readPresentation(manifest).find((p) => p.id === selectedNodeId);

  const validation = validateEditorManifest(manifest);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div
        className="overflow-hidden rounded-[10px] border border-line bg-paper"
        data-testid="flow-graph-editor"
      >
        <FlowEditorToolbar
          labels={labels}
          selectedNodeId={selectedNodeId}
          onAddGate={handleAddGate}
          onAddNode={handleAddNode}
          onRemoveNode={handleRemoveNode}
        />
        <div className="h-[440px] w-full">
          <ReactFlow
            fitView
            nodesConnectable
            nodesDraggable
            edges={edges}
            nodeTypes={nodeTypes}
            nodes={nodes}
            onConnect={handleConnect}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_event, node) => select(node.id)}
            onNodesChange={handleNodesChange}
            onPaneClick={() => select(null)}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
      <aside className="grid gap-3" data-testid="flow-graph-editor-sidebar">
        <EditorValidationSummary
          labels={labels.validation}
          result={validation}
          onSelectNode={select}
        />
        <NodeSideForm
          labels={labels.nodeForm}
          node={selectedNode}
          presentation={
            selectedPresentation
              ? {
                  width: selectedPresentation.width,
                  height: selectedPresentation.height,
                  color: selectedPresentation.color,
                }
              : undefined
          }
          onChange={handleNodeFormChange}
          onPresentationChange={handlePresentationChange}
        />
      </aside>
      {pendingConnection ? (
        <EdgeConnectModal
          duplicate={outcomeExistsForSource(
            manifest,
            pendingConnection.source,
            pendingOutcome,
          )}
          labels={labels.edgeModal}
          source={pendingConnection.source}
          target={pendingConnection.target}
          onCancel={cancelConnection}
          onConfirm={confirmConnection}
          onOutcomeChange={setPendingOutcome}
        />
      ) : null}
    </div>
  );
}
