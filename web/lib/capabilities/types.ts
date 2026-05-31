import type {
  CapabilityAgent,
  CapabilityEnforceability,
  CapabilityKind,
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
  material: CapabilityMaterial;
};

export type ResolvedCapabilityProfile = {
  projectId: string;
  executorAgent: "claude" | "codex";
  planMode: "off" | "plan-first";
  selectedMcpIds: string[];
  selectedSkillIds: string[];
  selectedRuleIds: string[];
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
  | ToolCapabilityConfig;

export type PlatformMcpCapability = McpCapabilityConfig & {
  source: "platform";
};

export type ProjectCapabilitiesInput = MaisterCapabilitiesConfig & {
  platformMcps?: PlatformMcpCapability[];
};
