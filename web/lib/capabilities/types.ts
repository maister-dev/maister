import type {
  AgentDefinitionCapabilityConfig,
  CapabilityAgent,
  CapabilityEnforceability,
  CapabilityKind,
  EnvProfileCapabilityConfig,
  McpCapabilityConfig,
  MaisterCapabilitiesConfig,
  RestrictionCapabilityConfig,
  RuleCapabilityConfig,
  SettingCapabilityConfig,
  SkillCapabilityConfig,
  ToolCapabilityConfig,
} from "@/lib/config.schema";

export type LaunchCapabilitySource = "platform" | "project" | "flow-package";

export type CapabilityMaterial = Record<string, unknown>;

export type CapabilityRecordInput = {
  capabilityRefId: string;
  kind: CapabilityKind;
  label: string;
  source: LaunchCapabilitySource;
  version: string | null;
  revision: string | null;
  agents: CapabilityAgent[] | Partial<Record<CapabilityAgent, string>>;
  enforceability: CapabilityEnforceability;
  selectedByDefault: boolean;
  selectable: boolean;
  material: CapabilityMaterial;
};

export type CapabilityCatalogRecord = CapabilityRecordInput & {
  id: string;
  projectId: string;
};

export type CapabilityProfileEntry = {
  id: string;
  capabilityRefId: string;
  kind: CapabilityCatalogRecord["kind"];
  source: LaunchCapabilitySource;
  label: string;
  enforceability: CapabilityCatalogRecord["enforceability"];
  revision: string | null;
  agentName: string | null;
  material: CapabilityMaterial;
};

export type ResolvedCapabilityProfile = {
  projectId: string;
  executorAgent: "claude" | "codex";
  planMode: "off" | "plan-first";
  workMode: "auto" | "plan_first" | "manual_approval";
  reasoningEffort: "low" | "high" | "extra" | "ultra";
  selectedMcpIds: string[];
  selectedSkillIds: string[];
  selectedRuleIds: string[];
  selectedAgentDefinitionIds: string[];
  selectedRestrictionIds: string[];
  enforced: CapabilityProfileEntry[];
  instructed: CapabilityProfileEntry[];
  supported: CapabilityProfileEntry[];
  unsupported: CapabilityProfileEntry[];
  refused: CapabilityProfileEntry[];
  downgraded: Array<CapabilityProfileEntry & { reason: string }>;
  profileDigest: string;
};

export type ProjectCapabilityConfig =
  | McpCapabilityConfig
  | SkillCapabilityConfig
  | RuleCapabilityConfig
  | RestrictionCapabilityConfig
  | SettingCapabilityConfig
  | ToolCapabilityConfig
  | AgentDefinitionCapabilityConfig
  | EnvProfileCapabilityConfig;

export type PlatformMcpCapability = McpCapabilityConfig & {
  source: "platform";
};

export type ProjectCapabilitiesInput = MaisterCapabilitiesConfig & {
  platformMcps?: PlatformMcpCapability[];
};
