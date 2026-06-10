// T7.2 (RED): failing unit tests for the PURE evidence-graph layout/transform
// helpers. The React Flow canvas itself is covered at E2E (Phase 8); only the
// pure dagre-layout + transform helpers get unit tests (this file runs in node;
// @dagrejs/dagre is pure JS, @xyflow/react is type-only here).
//
// Contract (module not built yet — RED on the missing import):
//   web/lib/board/evidence-graph-layout.ts exports
//     toFlowGraph(graph): { nodes: Node[]; edges: Edge[] }
//     layoutGraph(nodes, edges): Node[]   // dagre rankdir LR, positioned

import type { EvidenceGraph } from "@/lib/queries/evidence-graph";
import type { Edge, Node } from "@xyflow/react";

import { describe, expect, it } from "vitest";

import {
  type EvidenceTextLabels,
  artifactKindLabel,
  kindLabel,
  layoutGraph,
  stateLabel,
  toFlowGraph,
} from "@/lib/board/evidence-graph-layout";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

const TEXT_LABELS: EvidenceTextLabels = {
  stateCurrent: "Current",
  stateStale: "Stale",
  stateSuperseded: "Superseded",
  stateFailed: "Failed",
  stateSkipped: "Skipped",
  kindTaskInput: "Task input",
  kindNodeAttempt: "Node attempt",
  kindArtifact: "Artifact",
  kindGate: "Gate",
  kindDecision: "Decision",
  artifactKindMutationReport: "Mutation report",
};

// One node of each kind + a supersession edge (old → new) so the dashed-edge
// transform is exercised, plus a plain flow edge.
function sampleGraph(): EvidenceGraph {
  return {
    nodes: [
      {
        id: "task-input",
        kind: "task-input",
        label: "Build the thing",
        state: null,
        meta: {},
      },
      {
        id: "attempt-1",
        kind: "node-attempt",
        label: "implement #1",
        state: "Succeeded",
        meta: { nodeId: "implement", attempt: 1 },
      },
      {
        id: "artifact-old",
        kind: "artifact",
        label: "impl-diff (old)",
        state: "superseded",
        meta: { artifactId: "old", kind: "diff" },
      },
      {
        id: "artifact-new",
        kind: "artifact",
        label: "impl-diff",
        state: "stale",
        meta: { artifactId: "new", kind: "diff" },
      },
      {
        id: "gate-1",
        kind: "gate",
        label: "artifact_required",
        state: "failed",
        meta: { gateKind: "artifact_required", mode: "blocking" },
      },
      {
        id: "decision-1",
        kind: "decision",
        label: "approve",
        state: "approve",
        meta: { decision: "approve" },
      },
    ],
    edges: [
      {
        id: "e-input",
        source: "task-input",
        target: "attempt-1",
        kind: "input",
      },
      {
        id: "e-out",
        source: "attempt-1",
        target: "artifact-new",
        kind: "output",
      },
      {
        id: "e-sup",
        source: "artifact-old",
        target: "artifact-new",
        kind: "supersession",
      },
    ],
  };
}

describe("toFlowGraph", () => {
  it("maps nodes 1:1, preserving id and carrying kind/label/state in data", () => {
    const graph = sampleGraph();
    const { nodes } = toFlowGraph(graph);

    expect(nodes).toHaveLength(graph.nodes.length);

    // ids preserved 1:1.
    expect(new Set(nodes.map((n) => n.id))).toEqual(
      new Set(graph.nodes.map((n) => n.id)),
    );

    const staleArtifact = nodes.find((n) => n.id === "artifact-new");

    expect(staleArtifact).toBeDefined();
    const data = staleArtifact?.data as Record<string, unknown>;

    expect(data.kind).toBe("artifact");
    expect(data.state).toBe("stale");
    expect(data.label).toBe("impl-diff");

    // task-input node carries its kind too (renderer colors by kind).
    const taskInput = nodes.find((n) => n.id === "task-input");

    expect((taskInput?.data as Record<string, unknown>).kind).toBe(
      "task-input",
    );
  });

  it("maps edges 1:1, preserving id/source/target and flagging supersession as dashed", () => {
    const graph = sampleGraph();
    const { edges } = toFlowGraph(graph);

    expect(edges).toHaveLength(graph.edges.length);

    const byId = new Map(edges.map((e) => [e.id, e]));

    for (const src of graph.edges) {
      const mapped = byId.get(src.id);

      expect(mapped).toBeDefined();
      expect(mapped?.source).toBe(src.source);
      expect(mapped?.target).toBe(src.target);
    }

    // The supersession edge is distinguishable AND dashed.
    const sup = byId.get("e-sup");
    const supData = sup?.data as Record<string, unknown> | undefined;

    expect(supData?.kind).toBe("supersession");
    expect(supData?.dashed).toBe(true);

    // A non-supersession edge is NOT dashed.
    const plain = byId.get("e-input");
    const plainData = plain?.data as Record<string, unknown> | undefined;

    expect(plainData?.dashed).not.toBe(true);
  });
});

describe("layoutGraph", () => {
  // Two-node chain A → B with explicit dimensions so dagre can rank them.
  function chain(): { nodes: Node[]; edges: Edge[] } {
    const nodes: Node[] = [
      {
        id: "A",
        position: { x: 0, y: 0 },
        data: { kind: "node-attempt", label: "A", state: null },
        width: 180,
        height: 60,
      },
      {
        id: "B",
        position: { x: 0, y: 0 },
        data: { kind: "artifact", label: "B", state: "current" },
        width: 180,
        height: 60,
      },
    ];
    const edges: Edge[] = [{ id: "AB", source: "A", target: "B" }];

    return { nodes, edges };
  }

  it("positions every node with numeric x/y", () => {
    const { nodes: flowNodes, edges } = toFlowGraph(sampleGraph());
    const positioned = layoutGraph(flowNodes, edges);

    expect(positioned).toHaveLength(flowNodes.length);

    for (const node of positioned) {
      expect(typeof node.position.x).toBe("number");
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(typeof node.position.y).toBe("number");
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  it("lays out left-to-right: a downstream node has a greater x than its upstream", () => {
    const { nodes, edges } = chain();
    const positioned = layoutGraph(nodes, edges);

    const a = positioned.find((n) => n.id === "A");
    const b = positioned.find((n) => n.id === "B");

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b!.position.x).toBeGreaterThan(a!.position.x);
  });

  it("is deterministic: two runs on the same input yield identical positions", () => {
    const { nodes, edges } = chain();

    const first = layoutGraph(nodes, edges);
    const second = layoutGraph(nodes, edges);

    const pos = (ns: Node[]) =>
      ns
        .map((n) => `${n.id}:${n.position.x},${n.position.y}`)
        .sort()
        .join("|");

    expect(pos(second)).toBe(pos(first));
  });
});

describe("empty graph", () => {
  it("toFlowGraph({nodes:[],edges:[]}) returns empty arrays", () => {
    const out = toFlowGraph({ nodes: [], edges: [] });

    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it("layoutGraph([],[]) returns [] without throwing", () => {
    expect(layoutGraph([], [])).toEqual([]);
  });
});

describe("stateLabel / kindLabel", () => {
  it("translates known validity states", () => {
    expect(stateLabel("current", TEXT_LABELS)).toBe("Current");
    expect(stateLabel("stale", TEXT_LABELS)).toBe("Stale");
    expect(stateLabel("superseded", TEXT_LABELS)).toBe("Superseded");
    expect(stateLabel("failed", TEXT_LABELS)).toBe("Failed");
    expect(stateLabel("skipped", TEXT_LABELS)).toBe("Skipped");
  });

  it("falls back to the raw token for non-validity states (no invented keys)", () => {
    // Gate `passed` and attempt `Succeeded` have no catalog key → raw token.
    expect(stateLabel("passed", TEXT_LABELS)).toBe("passed");
    expect(stateLabel("Succeeded", TEXT_LABELS)).toBe("Succeeded");
    expect(stateLabel(null, TEXT_LABELS)).toBe("");
  });

  it("translates every node kind", () => {
    expect(kindLabel("task-input", TEXT_LABELS)).toBe("Task input");
    expect(kindLabel("node-attempt", TEXT_LABELS)).toBe("Node attempt");
    expect(kindLabel("artifact", TEXT_LABELS)).toBe("Artifact");
    expect(kindLabel("gate", TEXT_LABELS)).toBe("Gate");
    expect(kindLabel("decision", TEXT_LABELS)).toBe("Decision");
  });
});

// M29 (ADR-074): the mutation_report artifact kind is the first artifact kind
// with a catalog translation; every other kind passes through raw.
describe("artifactKindLabel", () => {
  it("translates mutation_report and falls back to the raw token otherwise", () => {
    expect(artifactKindLabel("mutation_report", TEXT_LABELS)).toBe(
      "Mutation report",
    );
    expect(artifactKindLabel("diff", TEXT_LABELS)).toBe("diff");
    expect(artifactKindLabel("commit_set", TEXT_LABELS)).toBe("commit_set");
  });

  it("renders the run-detail evidence label from the real EN and RU catalogs", () => {
    const enLabels = {
      ...TEXT_LABELS,
      artifactKindMutationReport: en.evidence.artifactKindMutationReport,
    };
    const ruLabels = {
      ...TEXT_LABELS,
      artifactKindMutationReport: ru.evidence.artifactKindMutationReport,
    };

    expect(artifactKindLabel("mutation_report", enLabels)).toBe(
      "Mutation report",
    );
    expect(artifactKindLabel("mutation_report", ruLabels)).toBe(
      "Отчёт об изменениях",
    );
  });
});
