import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalCommandJson } from "../../../runtime/command-json";
import { capabilityRefIdSchema } from "@/lib/config.schema";
import type { CapabilityCatalogRecord } from "./types";
import type { McpConfigOverlay } from "@/lib/db/schema";
import { pickMcpWinner, type McpBindingInput } from "./resolver";

export const mcpTargetSchema = z
  .object({
    refId: capabilityRefIdSchema,
    recordId: z.string().min(1),
    source: z.enum(["project", "platform", "flow-package"]),
    revision: z.string().nullable(),
    materialSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type AgentMcpTarget = z.infer<typeof mcpTargetSchema>;

/** Resolve the same logical target as materialization, retaining a digest instead of deployment configuration. */
export function agentMcpTargets(
  refs: readonly string[],
  catalog: readonly CapabilityCatalogRecord[],
  bindings: readonly McpBindingInput[],
  overlays: ReadonlyMap<string, McpConfigOverlay>,
): AgentMcpTarget[] {
  return [...new Set(refs)]
    .flatMap((refId) => {
      const binding = bindings.find((row) => row.refId === refId);
      const record = pickMcpWinner(
        catalog.filter(
          (row) => row.kind === "mcp" && row.capabilityRefId === refId,
        ),
        binding,
      )?.record;

      if (
        !record ||
        (binding &&
          binding.targetId !==
            (record.source === "platform" ? refId : record.id))
      )
        return [];
      // Readiness is host-specific telemetry. Only executable configuration belongs to the target witness.
      const { readiness: _readiness, ...material } = record.material;

      return [
        {
          refId,
          recordId: record.id,
          source: record.source,
          revision: record.revision,
          materialSha256: createHash("sha256")
            .update(
              canonicalCommandJson({
                material,
                overlay: overlays.get(refId) ?? {},
              }),
            )
            .digest("hex"),
        },
      ];
    })
    .sort((a, b) => a.refId.localeCompare(b.refId));
}
