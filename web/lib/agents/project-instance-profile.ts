import "server-only";

import type { ParsedAgentDefinition } from "./definition";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { CapabilityCatalogRecord } from "@/lib/capabilities/types";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { resolveEffectiveAgentDefinition } from "./effective";

import {
  agentMcpTargets,
  mcpTargetSchema,
} from "@/lib/capabilities/mcp-targets";
import { loadSelectableCapabilities } from "@/lib/capabilities/resolver";
import {
  loadProjectMcpBindings,
  loadProjectMcpOverlays,
} from "@/lib/mcp/binding-service";
import { capabilityRefIdSchema } from "@/lib/config.schema";
import { type Db } from "@/lib/execution-host/db";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { readPackageMcpScopes } from "@/lib/packages/mcp-scope";
import { postgresTextSchema } from "@/lib/text-schema";

export const promptOverrideSchema = postgresTextSchema
  .transform((value) => value.replace(/\r\n?/g, "\n"))
  .pipe(
    z
      .string()
      .max(65536)
      .refine((value) => value.trim().length > 0),
  );

export const additionalMcpRefsSchema = z
  .array(capabilityRefIdSchema)
  .max(64)
  .refine(
    (refs) => new Set(refs).size === refs.length,
    "MCP references must be unique",
  );

const linkProfileSchema = z.object({
  revision: z.number().int().positive(),
  promptOverride: promptOverrideSchema.nullable(),
  additionalMcpRefs: additionalMcpRefsSchema,
});

export type ProjectAgentProfile = z.infer<typeof linkProfileSchema>;

export {
  agentMcpTargets,
  type AgentMcpTarget,
} from "@/lib/capabilities/mcp-targets";

export const projectAgentProfileSnapshotSchema = z
  .object({
    version: z.literal(1),
    agentId: z.string().min(1),
    projectId: z.string().min(1),
    packageInstallId: z.string().min(1),
    prompt: postgresTextSchema,
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    promptOrigin: z.enum(["package", "project"]),
    packageMcpRefs: z.array(capabilityRefIdSchema),
    mcpTargets: z.array(mcpTargetSchema),
    additionalMcpRefs: additionalMcpRefsSchema,
    sharedMcps: z.array(
      z
        .object({
          refId: capabilityRefIdSchema,
          installId: z.string().min(1),
          attachmentId: z.string().min(1),
        })
        .strict(),
    ),
    linkRevision: z.number().int().positive(),
  })
  .strict()
  .refine(
    (snapshot) =>
      snapshot.promptSha256 ===
      createHash("sha256").update(snapshot.prompt).digest("hex"),
    "Persona digest mismatch",
  );

export type ProjectAgentProfileSnapshot = z.infer<
  typeof projectAgentProfileSnapshotSchema
>;

export async function readProjectAgentProfile(
  db: SqlTransaction,
  projectId: string,
  agentId: string,
): Promise<ProjectAgentProfile | null> {
  const result = await db.execute(sql`
    SELECT l.schedules_revision AS revision, l.prompt_override AS "promptOverride",
           ARRAY(SELECT a.ref_id FROM agent_project_mcp_additions a
                 WHERE a.link_id = l.id ORDER BY a.ref_id) AS "additionalMcpRefs"
    FROM agent_project_links l WHERE l.project_id = ${projectId} AND l.agent_id = ${agentId}
  `);

  if (!result.rows[0]) return null;
  const profile = linkProfileSchema.safeParse(result.rows[0]);

  if (!profile.success)
    throw new MaisterError("CONFIG", "Invalid stored agent instance profile");

  return profile.data;
}

/** Call only after repository-file read authorization. Package adoption can change divergence without a link edit. */
export async function readDivergentAgentIds(
  db: Db,
  projectId: string,
  visibleIds: readonly string[],
): Promise<Set<string>> {
  if (!visibleIds.length) return new Set();
  const { rows } =
    await db.execute(sql`SELECT agent_id,prompt_override FROM agent_project_links
    WHERE project_id=${projectId} AND prompt_override IS NOT NULL AND agent_id IN (${sql.join(
      visibleIds.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  const diverged = new Set<string>();

  for (const row of rows) {
    const { agent_id: agentId, prompt_override: prompt } = z
      .object({ agent_id: z.string(), prompt_override: promptOverrideSchema })
      .parse(row);

    try {
      const effective = await resolveEffectiveAgentDefinition(
        { projectId, agentId },
        db,
      );

      if (effective.parsed.prompt.replace(/\r\n?/g, "\n") !== prompt)
        diverged.add(agentId);
    } catch (error) {
      if (
        !isMaisterError(error) ||
        !["PRECONDITION", "CONFIG"].includes(error.code)
      )
        throw error;
    }
  }

  return diverged;
}

export function applyProjectAgentProfile(
  definition: ParsedAgentDefinition,
  profile: ProjectAgentProfile | null,
): {
  prompt: string;
  mcpRefs: string[];
} {
  return {
    prompt: profile?.promptOverride ?? definition.prompt,
    mcpRefs: [
      ...new Set([
        ...(definition.capabilityProfile?.mcps ?? []),
        ...(profile?.additionalMcpRefs ?? []),
      ]),
    ],
  };
}

/** A package-owned target must still be supplied by an installed, trusted release attached to this project. */
const trustedAgentMcpOwner = sql`(c.source <> 'flow-package' OR c.material->>'packageInstallId' IS NULL OR EXISTS (
  SELECT 1 FROM project_package_attachments a JOIN package_installs i ON i.id=a.package_install_id
  WHERE a.project_id=c.project_id AND i.id=c.material->>'packageInstallId'
    AND i.package_status='Installed' AND i.trust_status IN ('trusted','trusted_by_policy')
))`;

export async function availableAgentMcpCatalog(
  db: SqlTransaction,
  projectId: string,
): Promise<CapabilityCatalogRecord[]> {
  const [catalog, eligible] = await Promise.all([
    loadSelectableCapabilities(projectId, db),
    db.execute(sql`
    SELECT c.id FROM capability_records c WHERE c.project_id=${projectId} AND c.kind='mcp' AND ${trustedAgentMcpOwner}
  `),
  ]);
  const allowed = new Set(eligible.rows.map((row) => row.id));

  return catalog.filter((row) => row.kind === "mcp" && allowed.has(row.id));
}

/** Connected means a live project/package capability or the active target of this project's binding. */
export async function connectedAgentMcpRefs(
  db: SqlTransaction,
  projectId: string,
): Promise<string[]> {
  const { rows } = await db.execute(sql`
    SELECT DISTINCT c.capability_ref_id AS ref
    FROM capability_records c
    LEFT JOIN project_mcp_bindings b ON b.project_id=c.project_id AND b.ref_id=c.capability_ref_id
    LEFT JOIN platform_mcp_servers p ON c.source='platform' AND p.id=c.capability_ref_id
    WHERE c.project_id=${projectId} AND c.kind='mcp' AND c.selectable AND c.disabled_at IS NULL AND ${trustedAgentMcpOwner}
      AND (c.material->>'requirement') IS DISTINCT FROM 'true'
      AND (b.id IS NULL OR (b.enabled AND b.target_kind=CASE c.source
        WHEN 'flow-package' THEN 'package' ELSE c.source END
        AND b.target_id = CASE WHEN c.source='platform' THEN c.capability_ref_id ELSE c.id END))
      AND (c.source <> 'platform' OR (b.enabled AND p.enabled AND p.trust_status IN ('trusted','trusted_by_policy')))
    ORDER BY ref
  `);

  return rows.map((row) => capabilityRefIdSchema.parse(row.ref));
}

/** Capture the same attachment and link generation under which admission commits. */
export async function captureProjectAgentProfile(
  tx: SqlTransaction,
  input: {
    projectId: string;
    agentId: string;
    packageName: string;
    packageInstallId: string;
    definition: ParsedAgentDefinition;
  },
): Promise<ProjectAgentProfileSnapshot> {
  const { projectId, agentId, packageInstallId, definition } = input;
  const { rows } = await tx.execute(sql`
    SELECT l.id FROM project_package_attachments a
      JOIN agent_project_links l ON l.project_id = a.project_id
    WHERE a.project_id = ${projectId} AND a.package_name = ${input.packageName}
      AND a.package_install_id = ${packageInstallId} AND l.agent_id = ${agentId} AND l.enabled
    FOR SHARE OF a, l
  `);
  const profile = rows.length
    ? await readProjectAgentProfile(tx, projectId, agentId)
    : null;

  if (!profile)
    throw new MaisterError(
      "CONFLICT",
      "Agent attachment changed during launch",
    );
  const sharedMcps = (await readPackageMcpScopes(tx, projectId))
    .filter((row) => row.sharedWithAgents)
    .map(({ refId, installId, attachmentId }) => ({
      refId,
      installId,
      attachmentId,
    }));
  const profileRefs = applyProjectAgentProfile(definition, profile);
  const refs = [...profileRefs.mcpRefs, ...sharedMcps.map((row) => row.refId)];
  const mcpTargets = refs.length
    ? agentMcpTargets(
        refs,
        ...(await Promise.all([
          availableAgentMcpCatalog(tx, projectId),
          loadProjectMcpBindings(projectId, tx),
          loadProjectMcpOverlays(projectId, tx),
        ])),
      )
    : [];

  return {
    version: 1,
    projectId,
    agentId,
    packageInstallId,
    prompt: profileRefs.prompt,
    promptSha256: createHash("sha256").update(profileRefs.prompt).digest("hex"),
    mcpTargets,
    promptOrigin: profile.promptOverride === null ? "package" : "project",
    packageMcpRefs: definition.capabilityProfile?.mcps ?? [],
    additionalMcpRefs: profile.additionalMcpRefs,
    sharedMcps,
    linkRevision: profile.revision,
  };
}

export function retainedProjectAgentProfile(
  value: unknown,
  owner: { projectId: string; agentId: string; packageInstallId: string },
): ProjectAgentProfileSnapshot | null {
  if (value == null) return null;
  const result = projectAgentProfileSnapshotSchema.safeParse(value);

  if (
    !result.success ||
    result.data.projectId !== owner.projectId ||
    result.data.agentId !== owner.agentId ||
    result.data.packageInstallId !== owner.packageInstallId
  )
    throw new MaisterError(
      "CONFLICT",
      "Project agent profile does not match the captured launch owner",
    );

  return result.data;
}
