import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ParsedAgentDefinition } from "@/lib/agents/definition";

import { eq, sql } from "drizzle-orm";

import { projects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export async function assertAgentQualificationPolicy(
  db: Db,
  projectId: string,
  definition: ParsedAgentDefinition,
): Promise<void> {
  if (!definition.taskQualification) return;
  const [project] = await db
    .select({
      baseline: projects.taskQualificationBaseline,
      override: projects.taskQualificationOverride,
    })
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project || (project.override ?? project.baseline) !== "required")
    throw new MaisterError(
      "PRECONDITION",
      "Enable project.task_qualification=required before activating this intake or qualifier",
      { details: { reason: "qualification_policy_required" } },
    );
}

export async function assertAttachedQualificationAgentsPolicy(
  db: Db,
  projectId: string,
  definitions: readonly ParsedAgentDefinition[],
): Promise<void> {
  const qualifying = definitions.filter(
    (definition) => definition.taskQualification !== null,
  );

  if (!qualifying.length) return;
  const active =
    await db.execute(sql`SELECT agent_id FROM agent_project_links WHERE project_id=${projectId}
    AND enabled=true AND agent_id IN ${qualifying.map((definition) => definition.id)} LIMIT 1`);

  if (active.rows.length)
    await assertAgentQualificationPolicy(db, projectId, qualifying[0]);
}
