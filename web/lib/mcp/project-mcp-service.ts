import "server-only";

import type { ProjectMcpMaterial } from "@/lib/mcp/project-mcp";
import type { McpAgent, McpServerDraft } from "@/lib/mcp/mcp-form";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { validateMcpServerDraft } from "@/lib/mcp/mcp-form";
import {
  buildProjectMcpMaterial,
  materialToDraft,
  PROJECT_MCP_ORIGIN,
} from "@/lib/mcp/project-mcp";

// M27/T-C5: data layer for project-scoped MCPs (capability_records rows,
// source='project', kind='mcp'). `mcpId` in the item routes is the row's
// surrogate primary key; every lookup is scoped to the resolved project_id so a
// foreign row is never read/edited/deleted — that scoping IS the security
// boundary (cross-project → not-found / 404).

type ProjectMcpDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

type RecordRow = {
  id: string;
  capability_ref_id: string;
  label: string;
  material: ProjectMcpMaterial;
  selectable: boolean;
  disabled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

// Read DTO returned by GET (list + item). Flattens the material so the client
// modal can seed its form directly. Secrets are NAME-only references.
export type ProjectMcpDto = {
  id: string;
  mcpId: string;
  transport: McpServerDraft["transport"];
  command: string | null;
  args: string[];
  envKeys: string[];
  url: string | null;
  headerKeys: string[];
  supportedAgents: McpAgent[];
  selectable: boolean;
  enabled: boolean;
};

const log = pino({
  name: "project-mcp",
  level: process.env.LOG_LEVEL ?? "info",
});

function rowsOf<T>(result: { rows?: unknown[] }): T[] {
  return (result.rows ?? []) as T[];
}

function toDto(row: RecordRow): ProjectMcpDto {
  const draft = materialToDraft(row.capability_ref_id, row.material);

  return {
    id: row.id,
    mcpId: row.capability_ref_id,
    transport: draft.transport,
    command: draft.command,
    args: draft.args,
    envKeys: draft.envKeys,
    url: draft.url,
    headerKeys: draft.headerKeys,
    supportedAgents: draft.supportedAgents,
    selectable: row.selectable,
    enabled: row.disabled_at === null,
  };
}

function db(injected?: ProjectMcpDb): ProjectMcpDb {
  return injected ?? (getDb() as unknown as ProjectMcpDb);
}

function assertValidDraft(draft: McpServerDraft): void {
  const validation = validateMcpServerDraft(draft);

  if (!validation.ok) {
    throw new MaisterError(
      "CONFIG",
      `invalid project MCP: ${validation.errors
        .map((e) => `${e.field}: ${e.message}`)
        .join("; ")}`,
    );
  }
}

export async function listProjectMcps(
  projectId: string,
  injected?: ProjectMcpDb,
): Promise<ProjectMcpDto[]> {
  const result = await db(injected).execute(sql`
    SELECT id, capability_ref_id, label, material, selectable,
           disabled_at, created_at, updated_at
    FROM capability_records
    WHERE project_id = ${projectId}
      AND source = 'project'
      AND kind = 'mcp'
      AND material->>'origin' = ${PROJECT_MCP_ORIGIN}
    ORDER BY capability_ref_id ASC
  `);

  return rowsOf<RecordRow>(result).map(toDto);
}

// Item lookup is project-scoped: a row whose project_id ≠ the resolved project
// is invisible here, so the caller turns the null into a 404 — never a
// cross-project read.
async function loadScopedRow(
  database: ProjectMcpDb,
  projectId: string,
  mcpId: string,
): Promise<RecordRow | null> {
  const result = await database.execute(sql`
    SELECT id, capability_ref_id, label, material, selectable,
           disabled_at, created_at, updated_at
    FROM capability_records
    WHERE id = ${mcpId}
      AND project_id = ${projectId}
      AND source = 'project'
      AND kind = 'mcp'
      AND material->>'origin' = ${PROJECT_MCP_ORIGIN}
    LIMIT 1
  `);

  return rowsOf<RecordRow>(result)[0] ?? null;
}

export async function getProjectMcp(
  projectId: string,
  mcpId: string,
  injected?: ProjectMcpDb,
): Promise<ProjectMcpDto | null> {
  const row = await loadScopedRow(db(injected), projectId, mcpId);

  return row ? toDto(row) : null;
}

export async function createProjectMcp(
  projectId: string,
  draft: McpServerDraft,
  injected?: ProjectMcpDb,
): Promise<ProjectMcpDto> {
  assertValidDraft(draft);

  const database = db(injected);
  const recordId = randomUUID();
  const material = buildProjectMcpMaterial(draft);
  const agentsJson = JSON.stringify(material.supportedAgents);
  const materialJson = JSON.stringify(material);

  // Race-safe create: the unique (project_id, source, kind, capability_ref_id)
  // constraint, surfaced as the typed 409 via an empty RETURNING — never a raw
  // 23505 → 500 (mirrors the platform admin route).
  const inserted = await database.execute(sql`
    INSERT INTO capability_records (
      id, project_id, capability_ref_id, kind, label, source,
      version, agents, enforceability, selected_by_default, selectable,
      material, disabled_at, created_at, updated_at
    )
    VALUES (
      ${recordId}, ${projectId}, ${draft.id}, 'mcp', ${draft.id}, 'project',
      'local', ${agentsJson}::jsonb, 'enforced', true, true,
      ${materialJson}::jsonb, NULL, now(), now()
    )
    ON CONFLICT (project_id, source, kind, capability_ref_id) DO NOTHING
    RETURNING id, capability_ref_id, label, material, selectable,
              disabled_at, created_at, updated_at
  `);
  const row = rowsOf<RecordRow>(inserted)[0];

  if (!row) {
    throw new MaisterError(
      "CONFLICT",
      `project MCP already exists: ${draft.id}`,
    );
  }

  log.debug(
    { projectId, mcpId: recordId, ref: draft.id },
    "project MCP created",
  );

  return toDto(row);
}

export type ProjectMcpPatch = {
  transport?: McpServerDraft["transport"];
  command?: string | null;
  args?: string[];
  envKeys?: string[];
  url?: string | null;
  headerKeys?: string[];
  supportedAgents?: McpAgent[];
  enabled?: boolean;
};

export async function updateProjectMcp(
  projectId: string,
  mcpId: string,
  patch: ProjectMcpPatch,
  injected?: ProjectMcpDb,
): Promise<ProjectMcpDto | null> {
  const database = db(injected);
  const current = await loadScopedRow(database, projectId, mcpId);

  if (!current) return null;

  const base = materialToDraft(current.capability_ref_id, current.material);
  const nextDraft: McpServerDraft = {
    id: current.capability_ref_id,
    transport: patch.transport ?? base.transport,
    command: patch.command ?? base.command,
    args: patch.args ?? base.args,
    envKeys: patch.envKeys ?? base.envKeys,
    url: patch.url ?? base.url,
    headerKeys: patch.headerKeys ?? base.headerKeys,
    supportedAgents: patch.supportedAgents ?? base.supportedAgents,
  };

  assertValidDraft(nextDraft);

  const material = buildProjectMcpMaterial(nextDraft);
  const agentsJson = JSON.stringify(material.supportedAgents);
  const materialJson = JSON.stringify(material);
  // Enablement only changes when `enabled` is in the patch; an unrelated field
  // edit must NOT flip a disabled MCP back on (or vice versa).
  const wasEnabled = current.disabled_at === null;
  const enabled = patch.enabled ?? wasEnabled;
  const disabledAt = enabled ? null : (current.disabled_at ?? new Date());

  await database.execute(sql`
    UPDATE capability_records
    SET label = ${nextDraft.id},
        agents = ${agentsJson}::jsonb,
        material = ${materialJson}::jsonb,
        selectable = ${enabled},
        disabled_at = ${disabledAt},
        updated_at = now()
    WHERE id = ${mcpId}
      AND project_id = ${projectId}
      AND source = 'project'
      AND kind = 'mcp'
  `);

  log.debug({ projectId, mcpId }, "project MCP updated");

  return getProjectMcp(projectId, mcpId, database);
}

export async function deleteProjectMcp(
  projectId: string,
  mcpId: string,
  injected?: ProjectMcpDb,
): Promise<boolean> {
  const database = db(injected);
  const deleted = await database.execute(sql`
    DELETE FROM capability_records
    WHERE id = ${mcpId}
      AND project_id = ${projectId}
      AND source = 'project'
      AND kind = 'mcp'
      AND material->>'origin' = ${PROJECT_MCP_ORIGIN}
    RETURNING id
  `);

  if (rowsOf<{ id: string }>(deleted).length === 0) return false;

  log.info({ projectId, mcpId }, "project MCP deleted");

  return true;
}
