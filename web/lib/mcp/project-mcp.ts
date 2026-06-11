// M27/T-C5: pure material logic for project-scoped MCPs. A project MCP is a
// `capability_records` row (source='project', kind='mcp'); its definition lives
// in the `material` jsonb. This module is the single mapping between an
// `McpServerDraft` (validated by lib/mcp/mcp-form.ts, shared with the platform
// admin surface) and that material — keeping the route handlers thin. NOT
// server-only: no I/O here, only validation + shape builders. Secrets are NEVER
// values — env/header entries persist as `env:NAME` references (or bare NAMEs)
// resolved supervisor-side, exactly like the platform projection.

import type { McpServerDraft } from "@/lib/mcp/mcp-form";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { buildMcpServerFields } from "@/lib/mcp/mcp-form";

export const PROJECT_MCP_ORIGIN = "project-mcp" as const;

// The `material` jsonb persisted for a project MCP capability record. Carries
// only NAME-only secret references (`envKeys`/`headerKeys`), never values.
export type ProjectMcpMaterial = {
  origin: typeof PROJECT_MCP_ORIGIN;
  transport: McpServerDraft["transport"];
  command: string | null;
  args: string[];
  envKeys: string[];
  url: string | null;
  headerKeys: string[];
  supportedAgents: NonNullable<McpServerDraft["supportedAgents"]>;
};

// Build the persisted material from a validated draft. `buildMcpServerFields`
// normalizes off-transport fields away (stdio → command/args/env; sse/http →
// url/headers) so a transport switch never leaves stale config behind.
export function buildProjectMcpMaterial(
  draft: McpServerDraft,
): ProjectMcpMaterial {
  const fields = buildMcpServerFields(draft);

  return {
    origin: PROJECT_MCP_ORIGIN,
    transport: fields.transport,
    command: fields.command,
    args: fields.args,
    envKeys: fields.envKeys,
    url: fields.url,
    headerKeys: fields.headerKeys,
    supportedAgents: fields.supportedAgents,
  };
}

// Reconstruct an editable draft from a stored material (for PATCH merge + the
// read DTO). `id` is the project MCP's stable human ref (capability_ref_id).
export function materialToDraft(
  id: string,
  material: ProjectMcpMaterial,
): Required<
  Pick<
    McpServerDraft,
    | "id"
    | "transport"
    | "command"
    | "args"
    | "envKeys"
    | "url"
    | "headerKeys"
    | "supportedAgents"
  >
> {
  return {
    id,
    transport: material.transport,
    command: material.command ?? null,
    args: material.args ?? [],
    envKeys: material.envKeys ?? [],
    url: material.url ?? null,
    headerKeys: material.headerKeys ?? [],
    supportedAgents: material.supportedAgents ?? [...ADAPTER_IDS],
  };
}
