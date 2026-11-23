import "server-only";

import type { SQL } from "drizzle-orm";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import {
  projectPackageAttachments,
  projectPackageMcpScopeOverrides,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "package-mcp-scope",
  level: process.env.LOG_LEVEL ?? "info",
});

export type McpScope = "project" | "package";
export type AttachmentMcpScope = {
  refId: string;
  attachmentId: string;
  installId: string;
  declared: McpScope;
  effective: McpScope;
  sharedWithAgents: boolean;
  origin: "package" | "override";
  revision: number;
};

export const mcpScopeWriteSchema = z
  .object({
    scope: z.enum(["package", "project"]).nullable(),
    expectedInstallId: z.string().min(1).max(256),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

/** Read declarations and sparse overrides in one statement, including unbound requirement slots. */
export async function readPackageMcpScopes(
  database: { execute(query: SQL): Promise<{ rows?: unknown[] }> },
  projectId: string,
  flowPackageInstallId: string | null = null,
): Promise<AttachmentMcpScope[]> {
  const result = await database.execute(sql`
    SELECT a.id AS "attachmentId", p.id AS "installId", a.scope_revision AS revision,
           m.declaration->>'id' AS "refId", d.declared, COALESCE(o.scope, d.declared) AS effective,
           CASE WHEN o.scope IS NULL THEN 'package' ELSE 'override' END AS origin,
           COALESCE(o.scope = 'project', p.manifest->'spec'->'delivery'->>'version' = '1' AND d.declared = 'project', false) AS "sharedWithAgents"
      FROM project_package_attachments a
      LEFT JOIN package_installs selected ON selected.id=${flowPackageInstallId} AND selected.name=a.package_name
      JOIN package_installs p ON p.id = COALESCE(selected.id,a.package_install_id)
      CROSS JOIN LATERAL jsonb_array_elements(p.manifest->'spec'->'mcps') AS m(declaration)
      CROSS JOIN LATERAL (SELECT COALESCE(m.declaration->>'scope',
        CASE WHEN p.manifest->'spec'->'delivery'->>'version' = '1' THEN 'package' ELSE 'project' END
      ) AS declared) AS d
      LEFT JOIN project_package_mcp_scope_overrides o ON o.attachment_id = a.id AND o.ref_id = m.declaration->>'id'
     WHERE a.project_id = ${projectId}
     ORDER BY a.id, m.declaration->>'id'
  `);

  return (result.rows ?? []) as AttachmentMcpScope[];
}

export async function setPackageMcpScope(
  input: {
    projectId: string;
    attachmentId: string;
    refId: string;
    mutation: z.infer<typeof mcpScopeWriteSchema>;
  },
  database = getDb(),
): Promise<AttachmentMcpScope | null> {
  const { projectId, attachmentId, refId, mutation } = input;

  const result = await database.transaction(async (tx) => {
    const [attachment] = await tx
      .select({
        pin: projectPackageAttachments.packageInstallId,
        revision: projectPackageAttachments.scopeRevision,
      })
      .from(projectPackageAttachments)
      .where(
        and(
          eq(projectPackageAttachments.id, attachmentId),
          eq(projectPackageAttachments.projectId, projectId),
        ),
      )
      .for("update");

    if (!attachment) return null;
    if (
      attachment.pin !== mutation.expectedInstallId ||
      attachment.revision !== mutation.expectedRevision
    )
      throw new MaisterError(
        "CONFLICT",
        "Package scope changed. Reload the project MCPs before saving.",
        { details: { currentRevision: attachment.revision } },
      );
    const declarations = await readPackageMcpScopes(tx, projectId);
    const current = declarations.find(
      (row) => row.attachmentId === attachmentId && row.refId === refId,
    );
    if (!current) return null;

    if (mutation.scope === null) {
      await tx
        .delete(projectPackageMcpScopeOverrides)
        .where(
          and(
            eq(projectPackageMcpScopeOverrides.attachmentId, attachmentId),
            eq(projectPackageMcpScopeOverrides.refId, refId),
          ),
        );
    } else {
      await tx
        .insert(projectPackageMcpScopeOverrides)
        .values({ attachmentId, refId, scope: mutation.scope })
        .onConflictDoUpdate({
          target: [
            projectPackageMcpScopeOverrides.attachmentId,
            projectPackageMcpScopeOverrides.refId,
          ],
          set: { scope: mutation.scope },
        });
    }
    const revision = attachment.revision + 1;
    await tx
      .update(projectPackageAttachments)
      .set({ scopeRevision: revision })
      .where(eq(projectPackageAttachments.id, attachmentId));
    const updated = (await readPackageMcpScopes(tx, projectId)).find(
      (row) => row.attachmentId === attachmentId && row.refId === refId,
    );
    if (!updated)
      throw new MaisterError(
        "CONFLICT",
        "The updated scope no longer belongs to the attached release",
      );
    return updated;
  });
  if (result)
    log.info(
      {
        projectId,
        attachmentId,
        refId,
        revision: result.revision,
        origin: result.origin,
      },
      "MCP sharing scope saved",
    );
  return result;
}
