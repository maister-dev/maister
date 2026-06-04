import "server-only";

import type { AiCodingSettings } from "@/lib/config.schema";

import { MaisterError } from "@/lib/errors";
import { capabilityBearingSettings } from "@/lib/flows/enforcement";
import { compileManifest } from "@/lib/flows/graph/compile";

export type FlowRunnerRemapRow = {
  readonly stepId: string;
  readonly sourceRunnerId: string;
  readonly mappedRunnerId: string | null;
  readonly status: "Pending" | "Mapped";
};

function remapKey(stepId: string, runnerId: string): string {
  return `${stepId}\u0000${runnerId}`;
}

export function resolveCompiledStepTargetRunnerId(args: {
  readonly compiled: ReturnType<typeof compileManifest>;
  readonly remaps: readonly FlowRunnerRemapRow[];
  readonly flowRefId: string;
}): string | null {
  const mappedByStepAndSource = new Map(
    args.remaps.map((remap) => [
      remapKey(remap.stepId, remap.sourceRunnerId),
      remap,
    ]),
  );
  const targets = new Map<string, string>();

  for (const node of args.compiled.nodes.values()) {
    if (node.nodeType !== "ai_coding") continue;

    const settings = capabilityBearingSettings(node.nodeType, node.settings) as
      | AiCodingSettings
      | undefined;
    const sourceRunnerId = settings?.runner;

    if (!sourceRunnerId) continue;

    const remap = mappedByStepAndSource.get(remapKey(node.id, sourceRunnerId));

    if (remap) {
      if (remap.status !== "Mapped" || !remap.mappedRunnerId) {
        throw new MaisterError(
          "CONFIG",
          `flow "${args.flowRefId}" node "${node.id}" runner "${sourceRunnerId}" requires ACP runner remapping before launch`,
        );
      }

      targets.set(node.id, remap.mappedRunnerId);
      continue;
    }

    targets.set(node.id, sourceRunnerId);
  }

  const distinctTargets = [...new Set(targets.values())];

  if (distinctTargets.length > 1) {
    throw new MaisterError(
      "CONFIG",
      `flow "${args.flowRefId}" has multiple AI-coding runner targets (${distinctTargets.join(", ")}); one-run workspace runner resolution supports a single ACP runner`,
    );
  }

  return distinctTargets[0] ?? null;
}
