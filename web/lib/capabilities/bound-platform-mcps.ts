import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CapabilityCatalogRecord } from "./types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { platformMcpTargetRecordId } from "./mcp-targets";

import {
  capabilityAgentSchema,
  capabilityRefIdSchema,
} from "@/lib/config.schema";

const platformBinding = z.object({
  refId: capabilityRefIdSchema,
  enabled: z.boolean(),
  targetId: capabilityRefIdSchema.nullable(),
  agents: z.array(capabilityAgentSchema).nullable(),
  material: z.record(z.string(), z.unknown()),
});

/** Project bindings address the live platform catalog even while its projection is stale. */
export async function withBoundPlatformMcpRecords(
  db: SqlTransaction,
  projectId: string,
  projected: CapabilityCatalogRecord[],
): Promise<CapabilityCatalogRecord[]> {
  const { rows } = await db.execute(sql`
    SELECT b.ref_id AS "refId", b.enabled, p.id AS "targetId", p.supported_agents AS agents,
           jsonb_build_object('transport', p.transport,
             'command', CASE WHEN p.transport='stdio' THEN p.command END,
             'args', CASE WHEN p.transport='stdio' THEN p.args ELSE '[]'::jsonb END,
             'env', CASE WHEN p.transport='stdio' THEN p.env ELSE '{}'::jsonb END,
             'url', CASE WHEN p.transport IN ('http','sse') THEN p.url END,
             'headers', CASE WHEN p.transport IN ('http','sse') THEN p.headers ELSE '{}'::jsonb END,
             'bearerTokenEnv', CASE WHEN p.transport IN ('http','sse') THEN p.bearer_token_env END
           ) AS material
    FROM project_mcp_bindings b LEFT JOIN platform_mcp_servers p
      ON p.id=b.target_id AND p.id=b.ref_id AND p.enabled
      AND p.trust_status IN ('trusted','trusted_by_policy')
    WHERE b.project_id=${projectId} AND b.target_kind='platform'
  `);
  const bindings = rows.map((row) => platformBinding.parse(row));
  const boundRefs = new Set(bindings.map((row) => row.refId));

  return [
    ...projected.filter(
      (row) =>
        row.kind !== "mcp" ||
        row.source !== "platform" ||
        !boundRefs.has(row.capabilityRefId),
    ),
    ...bindings.flatMap((row): CapabilityCatalogRecord[] => {
      if (!row.enabled || !row.targetId || !row.agents) return [];
      const existing = projected.find(
        (record) =>
          record.kind === "mcp" &&
          record.source === "platform" &&
          record.capabilityRefId === row.refId,
      );

      return [
        {
          id: existing?.id ?? platformMcpTargetRecordId(row.refId),
          projectId,
          capabilityRefId: row.refId,
          kind: "mcp",
          source: "platform",
          label: existing?.label ?? row.refId,
          version: existing?.version ?? null,
          revision: existing?.revision ?? null,
          agents: row.agents,
          selectable: true,
          selectedByDefault: existing?.selectedByDefault ?? true,
          enforceability: "enforced",
          material: row.material,
        },
      ];
    }),
  ];
}
