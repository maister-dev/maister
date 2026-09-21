// M27/T-C5: pure material logic for project-scoped MCPs. A project MCP is a
// `capability_records` row (source='project', kind='mcp'); its definition lives
// in the `material` jsonb. This module is the single mapping between an
// `McpServerDraft` (validated by lib/mcp/mcp-form.ts, shared with the platform
// admin surface) and that material — keeping the route handlers thin. NOT
// server-only: no I/O here, only validation + shape builders. ADR-179: env and
// header entries persist as `Record<name, value>` maps whose values are
// whole-value `literal | env:NAME`, exactly like the platform projection; the
// value behind a REFERENCE is resolved only on the execution host.

import type { McpServerDraft } from "@/lib/mcp/mcp-form";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { buildMcpServerFields } from "@/lib/mcp/mcp-form";

export const PROJECT_MCP_ORIGIN = "project-mcp" as const;

// The `material` jsonb persisted for a project MCP capability record.
export type ProjectMcpMaterial = {
  origin: typeof PROJECT_MCP_ORIGIN;
  description?: string | null;
  transport: McpServerDraft["transport"];
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  bearerTokenEnv?: string | null;
  supportedAgents: NonNullable<McpServerDraft["supportedAgents"]>;
  // ADR-179 (D18): the write-time readiness cache. `composeProjectMcpHub` reads
  // it for non-platform entries — a write-only cache is not state.
  readiness?: { status: "Unknown" | "Ready" | "NotReady"; reasons: string[] };
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
    description: fields.description,
    transport: fields.transport,
    command: fields.command,
    args: fields.args,
    env: fields.env,
    url: fields.url,
    headers: fields.headers,
    bearerTokenEnv: fields.bearerTokenEnv,
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
    | "description"
    | "transport"
    | "command"
    | "args"
    | "env"
    | "url"
    | "headers"
    | "bearerTokenEnv"
    | "supportedAgents"
  >
> {
  return {
    id,
    description: material.description ?? null,
    transport: material.transport,
    command: material.command ?? null,
    args: material.args ?? [],
    env: material.env ?? {},
    url: material.url ?? null,
    headers: material.headers ?? {},
    bearerTokenEnv: material.bearerTokenEnv ?? null,
    supportedAgents: material.supportedAgents ?? [...ADAPTER_IDS],
  };
}
