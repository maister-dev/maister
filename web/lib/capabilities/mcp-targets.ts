import type { CapabilityCatalogRecord } from "./types";
import type { McpConfigOverlay } from "@/lib/db/schema";

import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { pickMcpWinner, type McpBindingInput } from "./resolver";

import { capabilityRefIdSchema } from "@/lib/config.schema";

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

export function platformMcpTargetRecordId(refId: string): string {
  return `platform:${refId}`;
}

/** Preserve retained projection IDs when an explicitly bound live server acquires a projection. */
export function matchesAgentMcpTarget(
  retained: AgentMcpTarget | undefined,
  current: AgentMcpTarget,
  binding: McpBindingInput | undefined,
): boolean {
  return (
    retained !== undefined &&
    retained.source === current.source &&
    retained.revision === current.revision &&
    retained.materialSha256 === current.materialSha256 &&
    (retained.recordId === current.recordId ||
      (current.source === "platform" &&
        binding?.enabled === true &&
        binding.targetKind === "platform" &&
        binding.targetId === current.refId &&
        retained.recordId === platformMcpTargetRecordId(current.refId)))
  );
}

export function eligibleAgentMcpRecord(
  refId: string,
  catalog: readonly CapabilityCatalogRecord[],
  binding: McpBindingInput | undefined,
): CapabilityCatalogRecord | undefined {
  const record = pickMcpWinner(
    catalog.filter(
      (row) => row.kind === "mcp" && row.capabilityRefId === refId,
    ),
    binding,
  )?.record;

  if (
    binding &&
    record &&
    binding.targetId !== (record.source === "platform" ? refId : record.id)
  )
    return undefined;

  return record;
}

/** PostgreSQL JSONB omits absent optional descriptor and overlay fields. Both admission and dispatch hash that representation. */
function definedOptions(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

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
      const record = eligibleAgentMcpRecord(refId, catalog, binding);

      if (!record) return [];
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
                material: definedOptions(material),
                overlay: definedOptions(overlays.get(refId) ?? {}),
              }),
            )
            .digest("hex"),
        },
      ];
    })
    .sort((a, b) => a.refId.localeCompare(b.refId));
}
