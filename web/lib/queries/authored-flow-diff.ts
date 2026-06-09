import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";

import { stringify as stringifyYaml } from "yaml";

import { unifiedLineDiff } from "@/lib/flows/editor/text-diff";
import { compileManifest } from "@/lib/flows/graph/compile";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";

export type AuthoredFlowDiff = {
  publishedYaml: string;
  draftYaml: string;
  diff: string;
  draftTopology: GraphTopology;
  draftLayout: FlowLayout;
  publishedTopology: GraphTopology | null;
  publishedLayout: FlowLayout | null;
  draftVersion: number;
  kind: "flow";
};

/**
 * M27/T-A6: pure read model for the flow editor's before/after view — the
 * draft manifest vs the last published one. Produces the `flow.yaml` line diff
 * (empty string when identical) plus both compiled topologies so the page can
 * render the published graph (read-only) beside the draft graph. No DB/I/O —
 * the caller resolves the two manifests and the draft version.
 *
 * `publishedManifest` is null for a flow that has never been published; the
 * published side then degrades to an empty YAML / null topology and the diff is
 * a pure addition.
 */
export function buildAuthoredFlowDiff(
  draftManifest: FlowYamlV1,
  publishedManifest: FlowYamlV1 | null,
  draftVersion: number,
): AuthoredFlowDiff {
  const draftYaml = stringifyYaml(draftManifest);
  const publishedYaml = publishedManifest
    ? stringifyYaml(publishedManifest)
    : "";

  return {
    publishedYaml,
    draftYaml,
    diff: unifiedLineDiff(publishedYaml, draftYaml),
    draftTopology: buildGraphTopology(compileManifest(draftManifest)),
    draftLayout: presentationLayout(draftManifest),
    publishedTopology: publishedManifest
      ? buildGraphTopology(compileManifest(publishedManifest))
      : null,
    publishedLayout: publishedManifest
      ? presentationLayout(publishedManifest)
      : null,
    draftVersion,
    kind: "flow",
  };
}
