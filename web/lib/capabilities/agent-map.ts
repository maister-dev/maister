import type { CapabilityAgent } from "@/lib/config.schema";
import type {
  CapabilityMaterial,
  CapabilityProfileEntry,
  ResolvedCapabilityProfile,
} from "@/lib/capabilities/types";

import pino from "pino";

const log = pino({
  name: "capabilities",
  level: process.env.LOG_LEVEL ?? "info",
});

// M27/T-C4: transport-tagged. `stdio` carries command/args/envKeys; `sse`/`http`
// carry url/headerKeys. Header/env values are resolved supervisor-side from the
// NAME keys — never carried here. Exception (M33, ADR-087): `env` carries
// literal values for server-GENERATED secrets that exist in no process.env
// (the per-launch ephemeral agent token injected into the MCP facade).
export type AgentMcpServer = {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  envKeys?: string[];
  env?: Record<string, string>;
  url?: string;
  headerKeys?: string[];
};

export type AgentSettingsLocal = {
  permissions: { allow?: string[]; defaultMode?: string };
  model?: string;
  availableModels?: string[];
};

export type AgentMaterializedSkill = {
  refId: string;
  material: CapabilityMaterial;
};

export type AgentMaterialization = {
  settingsLocal: AgentSettingsLocal | null;
  mcpServers: AgentMcpServer[];
  skills: AgentMaterializedSkill[];
};

export type MapProfileToAgentArtifactsArgs = {
  profile: ResolvedCapabilityProfile;
  agent: CapabilityAgent;
  tools?: string[];
  permissionMode?: "ask" | "allow" | "deny";
  model?: string;
};

const PERMISSION_MODE_TO_DEFAULT_MODE: Record<
  NonNullable<MapProfileToAgentArtifactsArgs["permissionMode"]>,
  string
> = {
  ask: "default",
  allow: "bypassPermissions",
  deny: "plan",
};

function envKeysOf(material: CapabilityMaterial): string[] {
  return Array.isArray(material.envKeys) ? (material.envKeys as string[]) : [];
}

function headerKeysOf(material: CapabilityMaterial): string[] {
  return Array.isArray(material.headerKeys)
    ? (material.headerKeys as string[])
    : [];
}

function mcpServerFromMaterial(
  name: string,
  material: CapabilityMaterial,
): AgentMcpServer {
  const transport =
    material.transport === "sse" || material.transport === "http"
      ? material.transport
      : "stdio";

  if (transport === "sse" || transport === "http") {
    return {
      name,
      transport,
      url: typeof material.url === "string" ? material.url : "",
      headerKeys: headerKeysOf(material),
    };
  }

  return {
    name,
    transport: "stdio",
    command: typeof material.command === "string" ? material.command : "",
    args: Array.isArray(material.args) ? (material.args as string[]) : [],
    envKeys: envKeysOf(material),
  };
}

export function mapProfileToAgentArtifacts(
  args: MapProfileToAgentArtifactsArgs,
): AgentMaterialization {
  const supported: CapabilityProfileEntry[] = args.profile.supported;
  // M27/T-C4: MCP servers materialize for ACP agents through the
  // session/new mcpServers param. Only the
  // Claude-adapter-specific surfaces are gated to claude: `.claude/settings.
  // local.json` (permissions) and on-disk skill files. Non-Claude skills are
  // invoked through adapter-specific native mechanisms, not this MCP scope.
  const isClaude = args.agent === "claude";

  const allow = isClaude && args.tools?.length ? [...args.tools] : undefined;
  const defaultMode =
    isClaude && args.permissionMode
      ? PERMISSION_MODE_TO_DEFAULT_MODE[args.permissionMode]
      : undefined;
  // ADR-076 (decision 5): the configured runner model reaches the claude
  // adapter via settings.local.json's `model` field (the adapter calls
  // query.setModel() from settings at startup). `availableModels: [model]` is
  // the minimal allowlist that lets the adapter accept a non-Claude env-router
  // model id (e.g. glm-5.1) — and is correct for plain anthropic too, since a
  // run pins exactly one model. Other adapters apply the model via a separate
  // supervisor-side/advisory channel, so this is claude-only.
  const model = isClaude && args.model ? args.model : undefined;
  const permissions: AgentSettingsLocal["permissions"] = {};

  if (allow !== undefined) permissions.allow = allow;
  if (defaultMode !== undefined) permissions.defaultMode = defaultMode;

  const settingsLocal: AgentSettingsLocal | null =
    allow === undefined && defaultMode === undefined && model === undefined
      ? null
      : { permissions, ...(model ? { model, availableModels: [model] } : {}) };

  const mcpServers: AgentMcpServer[] = [];
  const skills: AgentMaterializedSkill[] = [];

  for (const entry of supported) {
    if (entry.kind === "mcp") {
      mcpServers.push(
        mcpServerFromMaterial(entry.capabilityRefId, entry.material),
      );
    } else if (entry.kind === "skill" && isClaude) {
      skills.push({ refId: entry.capabilityRefId, material: entry.material });
    }
  }

  log.debug(
    {
      agent: args.agent,
      mcpCount: mcpServers.length,
      skillCount: skills.length,
      toolCount: args.tools?.length ?? 0,
      hasPermissionMode: args.permissionMode !== undefined,
    },
    "[capabilities.agentMap] mapped profile",
  );

  return { settingsLocal, mcpServers, skills };
}

// M27/T-C8b (mcp-management.md §6.2): an MCP `stdio` server spawns a LOCAL
// command, so it is withheld until the owning flow revision is exec-trusted
// (the T-B3 `flow_revisions.exec_trust` axis) — "trust → execute, never
// execute-then-trust". `sse`/`http` connect to a remote URL (no local exec) and
// are never gated. The runner applies this to the materialized set BEFORE the
// servers reach the agent's createSession (the only spawn surface).
export function gateStdioMcpsByExecTrust(
  mcpServers: readonly AgentMcpServer[],
  execTrust: "untrusted" | "trusted",
): AgentMcpServer[] {
  if (execTrust === "trusted") return [...mcpServers];

  return mcpServers.filter((s) => s.transport !== "stdio");
}
