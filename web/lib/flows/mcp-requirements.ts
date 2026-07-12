import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { normalizeNodeMcps } from "@/lib/config.schema";
import { capabilityBearingSettings } from "@/lib/flows/enforcement";
import { compileManifest } from "@/lib/flows/graph/compile";

// ADR-129 (W-A / DEC-2): the MCP refs a flow manifest declares — the top-level
// required `mcps` (package-level) plus every capability-bearing node's
// `settings.mcps` (required/additional). This mirrors the launch-time derivation
// in `services/runs.ts` so the requirements ledger and the launch gate agree on
// which refs a flow needs. Compiling the manifest handles graph + legacy `steps`
// shapes uniformly; callers wrap this in try/catch so a malformed manifest yields
// no contribution rather than crashing the read model.
export function flowManifestMcpRequirements(manifest: FlowYamlV1): {
  required: string[];
  additional: string[];
} {
  const required = new Set<string>();
  const additional = new Set<string>();

  for (const ref of manifest.mcps ?? []) required.add(ref);

  const graph = compileManifest(manifest);

  for (const node of graph.nodes.values()) {
    const mcps = capabilityBearingSettings(node.nodeType, node.settings)?.mcps;
    const { required: nodeRequired, additional: nodeAdditional } =
      normalizeNodeMcps(mcps);

    for (const ref of nodeRequired) required.add(ref);
    for (const ref of nodeAdditional) additional.add(ref);
  }

  return {
    required: [...required],
    // A ref required by any node is not ALSO "additional".
    additional: [...additional].filter((ref) => !required.has(ref)),
  };
}
