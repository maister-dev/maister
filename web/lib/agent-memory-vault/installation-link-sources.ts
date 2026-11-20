import "server-only";

import type { SQL } from "drizzle-orm";
import type { InstallationRunAuthority } from "@/lib/agents/installation-authority";
import type { KnowledgePrincipal } from "@/lib/brain/knowledge-types";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { Db } from "@/lib/execution-host/db";
import type { VaultAccess, VaultRevision } from "./store";
import type { MemoryLink } from "./structure";

import { sql } from "drizzle-orm";

import { lookupNotePath } from "./indexes";
import { readVaultRevision, unavailableMemory } from "./store";
import { memoryLookupKey, parseMemoryStructure } from "./structure";

import { installationProjectAccess } from "@/lib/agents/installation-authority";
import { isBrainSchemaApplied } from "@/lib/brain/guard";
import {
  authorizeKnowledgeRevisionRead,
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
} from "@/lib/brain/knowledge-restrictions";

type SourceContext = Readonly<{
  principal: KnowledgePrincipal;
  authority?: InstallationRunAuthority;
  vaultId: string;
  priorProjects: readonly string[];
  canRead: VaultAccess["canRead"];
}>;

type LinkedSources = Readonly<{
  projectIds: readonly string[];
  restrictions: readonly VaultRevision["sourceRestrictions"][number][];
}>;

const empty: LinkedSources = { projectIds: [], restrictions: [] };
const projectSources = (projectIds: readonly string[]): LinkedSources => ({
  projectIds,
  restrictions: [],
});

function projectPolicy(context: SourceContext, id: SQL) {
  return context.authority
    ? installationProjectAccess(context.authority, id, "readBoard")
    : sql`true`;
}

async function noteLink(
  tx: Db,
  context: SourceContext,
  link: MemoryLink,
): Promise<LinkedSources> {
  const key = memoryLookupKey(link.target.replace(/\.md$/, ""));
  const path = lookupNotePath(link.target);
  const result = await tx.execute<{
    note_id: string;
    revision_id: string;
    path: string;
    heading: boolean;
  }>(sql`
    SELECT note_id,revision_id,path,(${link.fragment}::text IS NULL OR headings ? ${link.fragment}) AS heading
    FROM agent_memory_note_index WHERE vault_id=${context.vaultId}
      AND (path=${path} OR basename_key=${key} OR alias_keys ? ${key})
    ORDER BY (path=${path}) DESC, note_id LIMIT 2
  `);
  const [first, second] = result.rows;
  if (!first || (second && first.path !== path) || !first.heading) return empty;
  const revision = await readVaultRevision(
    tx,
    context.vaultId,
    first.note_id,
    first.revision_id,
  );
  if (!(await context.canRead(tx, revision))) return empty;

  return {
    projectIds: revision.sourceProjectIds,
    restrictions: revision.sourceRestrictions,
  };
}

async function entityLink(
  tx: Db,
  context: SourceContext,
  link: MemoryLink,
): Promise<LinkedSources> {
  if (link.kind === "repo") {
    if (context.priorProjects.length !== 1) throw unavailableMemory();

    return projectSources(context.priorProjects);
  }
  if (link.kind === "task" || link.kind === "run") {
    const scope = link.kind === "task" ? "tasks:read" : "runs:read";
    if (context.authority && !context.authority.scopes.includes(scope))
      throw unavailableMemory();
    const split = link.target.lastIndexOf("-");
    const taskNumber = Number(link.target.slice(split + 1));
    if (link.kind === "task" && !Number.isSafeInteger(taskNumber))
      throw unavailableMemory();
    const target =
      link.kind === "task"
        ? sql`SELECT project_id,NULL::jsonb AS restrictions FROM tasks WHERE number=${taskNumber} AND project_id=(
          SELECT id FROM projects WHERE task_key=${link.target.slice(0, split)}) FOR SHARE`
        : sql`SELECT project_id,knowledge_access->'restrictions' AS restrictions FROM runs WHERE id=${link.target} FOR SHARE`;
    const [row] = (
      await tx.execute<{ project_id: string; restrictions: unknown }>(sql`
      SELECT p.id AS project_id,found.restrictions FROM (${target}) found JOIN projects p ON p.id=found.project_id
      WHERE p.archived_at IS NULL AND ${projectPolicy(context, sql`p.id`)} FOR SHARE OF p
    `)
    ).rows;
    if (!row) throw unavailableMemory();
    const access = await authorizeSourceRestrictions(
      tx,
      context.principal,
      row.restrictions,
    );
    const restrictions = restrictionsForKnowledgeAccess(access);

    return {
      projectIds: [row.project_id, ...restrictionProjects(restrictions)],
      restrictions,
    };
  }
  if (link.kind !== "brain" && link.kind !== "knowledge") return empty;
  if (!(await isBrainSchemaApplied(tx))) throw unavailableMemory();
  if (link.kind === "brain") {
    const [row] = (
      await tx.execute<{ project_id: string }>(sql`
      SELECT p.id AS project_id FROM brain_items item JOIN projects p ON p.id=item.project_id
      WHERE item.id=${link.target} AND p.archived_at IS NULL AND item.status='active'
        AND item.visibility='owner_grants' AND coalesce(item.source_restrictions,'[]'::jsonb)='[]'::jsonb
        AND ${context.authority ? installationProjectAccess(context.authority, sql`p.id`, "readBrain") : sql`true`}
      FOR SHARE OF item,p
    `)
    ).rows;
    if (
      !row ||
      (context.authority && !context.authority.scopes.includes("memory:read"))
    )
      throw unavailableMemory();

    return {
      projectIds: [row.project_id],
      restrictions: [{ kind: "project", projectId: row.project_id }],
    };
  }
  if (context.authority && !context.authority.scopes.includes("knowledge:read"))
    throw unavailableMemory();
  const access = await authorizeKnowledgeRevisionRead(
    tx,
    context.principal,
    link.target,
    Number(link.fragment),
  );
  const restrictions = restrictionsForKnowledgeAccess(access);

  return { projectIds: restrictionProjects(restrictions), restrictions };
}

function restrictionProjects(
  restrictions: readonly KnowledgeAccessRestriction[],
) {
  return restrictions.flatMap((source) =>
    source.kind === "project" ||
    source.kind === "project_context" ||
    source.kind === "project_visibility" ||
    source.kind === "agent_memory"
      ? [source.projectId]
      : [],
  );
}

export async function installationLinkSources(
  tx: Db,
  context: SourceContext,
  content: string,
): Promise<LinkedSources> {
  const projects: string[] = [];
  const restrictions: VaultRevision["sourceRestrictions"][number][] = [];

  for (const link of parseMemoryStructure(content).links) {
    const source =
      link.kind === "note"
        ? await noteLink(tx, context, link)
        : await entityLink(tx, context, link);
    projects.push(...source.projectIds);
    restrictions.push(...source.restrictions);
  }

  return { projectIds: projects, restrictions };
}
