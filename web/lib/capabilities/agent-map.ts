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

export type AgentMcpServer = {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
};

export type AgentSettingsLocal = {
  permissions: { allow?: string[]; defaultMode?: string };
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

export function mapProfileToAgentArtifacts(
  args: MapProfileToAgentArtifactsArgs,
): AgentMaterialization {
  if (args.agent === "codex") {
    log.debug(
      {
        agent: args.agent,
        mcpCount: 0,
        skillCount: 0,
        toolCount: 0,
        hasPermissionMode: false,
      },
      "[capabilities.agentMap] mapped profile",
    );

    return { settingsLocal: null, mcpServers: [], skills: [] };
  }

  const supported: CapabilityProfileEntry[] = args.profile.supported;

  const allow = args.tools?.length ? [...args.tools] : undefined;
  const defaultMode = args.permissionMode
    ? PERMISSION_MODE_TO_DEFAULT_MODE[args.permissionMode]
    : undefined;
  const permissions: AgentSettingsLocal["permissions"] = {};

  if (allow !== undefined) permissions.allow = allow;
  if (defaultMode !== undefined) permissions.defaultMode = defaultMode;

  const settingsLocal: AgentSettingsLocal | null =
    allow === undefined && defaultMode === undefined ? null : { permissions };

  const mcpServers: AgentMcpServer[] = [];
  const skills: AgentMaterializedSkill[] = [];

  for (const entry of supported) {
    if (entry.kind === "mcp") {
      const material = entry.material;

      mcpServers.push({
        name: entry.capabilityRefId,
        command: typeof material.command === "string" ? material.command : "",
        args: Array.isArray(material.args) ? (material.args as string[]) : [],
        envKeys: envKeysOf(material),
      });
    } else if (entry.kind === "skill") {
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
