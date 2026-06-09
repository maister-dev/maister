import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { compileManifest } from "@/lib/flows/graph/compile";
import {
  presentationLayout,
  type FlowLayout,
} from "@/lib/flows/graph/presentation-layout";
import {
  buildGraphTopology,
  type GraphTopology,
} from "@/lib/queries/flow-graph-view";

export type AuthoredFlowGraph = {
  topology: GraphTopology;
  layout: FlowLayout;
  draftVersion: number;
  kind: "flow";
};

/**
 * M27/T-A1: project/package-scoped read model for the flow editor.
 *
 * Pure: compiles an authored `flow` draft manifest into the same React-Flow
 * topology the read-only M22 view uses (`buildGraphTopology`) plus the authored
 * `presentation` layout (ADR-064), tagged with the draft version the editor
 * holds for optimistic-concurrency saves. No DB/I/O — the caller resolves the
 * manifest + draftVersion and feeds them in.
 */
export function buildAuthoredFlowGraph(
  manifest: FlowYamlV1,
  draftVersion: number,
): AuthoredFlowGraph {
  const compiled = compileManifest(manifest);
  const topology = buildGraphTopology(compiled);
  const layout = presentationLayout(manifest);

  return { topology, layout, draftVersion, kind: "flow" };
}
