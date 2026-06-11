export const ADAPTER_IDS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "mimo",
] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

export const PROVIDER_KINDS = [
  "anthropic",
  "anthropic_compatible",
  "openai",
  "openai_compatible",
  "google_gemini",
  "google_vertex",
  "google_gateway",
  "agent_native",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PERMISSION_POLICIES = [
  "default",
  "dangerously_skip_permissions",
] as const;

export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];

export type AdapterModelChannel =
  | "settings_local"
  | "set_session_model"
  | "advisory";

export type AdapterResumeStrategy =
  | "session_resume"
  | "load_session_pending_smoke"
  | "session_resume_pending_smoke";

export type AdapterFsPolicy = "none";
export type AdapterMcpTransport = "stdio" | "sse" | "http";

export type AdapterSupport = {
  readonly id: AdapterId;
  readonly capabilityAgent: AdapterId;
  readonly providerKinds: readonly ProviderKind[];
  readonly permissionPolicies: readonly PermissionPolicy[];
  readonly binaryId: string;
  readonly launchCommandHint: readonly string[];
  readonly modelChannel: AdapterModelChannel;
  readonly resumeStrategy: AdapterResumeStrategy;
  readonly mcpTransports: readonly AdapterMcpTransport[];
  readonly fsPolicy: AdapterFsPolicy;
};

export const ADAPTER_SUPPORT = [
  {
    id: "claude",
    capabilityAgent: "claude",
    providerKinds: ["anthropic", "anthropic_compatible"],
    permissionPolicies: ["default", "dangerously_skip_permissions"],
    binaryId: "claude-agent-acp",
    launchCommandHint: ["claude-agent-acp"],
    modelChannel: "settings_local",
    resumeStrategy: "session_resume",
    mcpTransports: ["stdio", "sse", "http"],
    fsPolicy: "none",
  },
  {
    id: "codex",
    capabilityAgent: "codex",
    providerKinds: ["openai", "openai_compatible"],
    permissionPolicies: ["default"],
    binaryId: "codex-acp",
    launchCommandHint: ["codex-acp"],
    modelChannel: "set_session_model",
    resumeStrategy: "session_resume",
    mcpTransports: ["stdio", "sse", "http"],
    fsPolicy: "none",
  },
  {
    id: "gemini",
    capabilityAgent: "gemini",
    providerKinds: ["google_gemini", "google_vertex", "google_gateway"],
    permissionPolicies: ["default"],
    binaryId: "gemini",
    launchCommandHint: ["gemini", "--acp"],
    modelChannel: "advisory",
    resumeStrategy: "load_session_pending_smoke",
    mcpTransports: ["stdio", "sse", "http"],
    fsPolicy: "none",
  },
  {
    id: "opencode",
    capabilityAgent: "opencode",
    providerKinds: ["agent_native"],
    permissionPolicies: ["default"],
    binaryId: "opencode",
    launchCommandHint: ["opencode", "acp"],
    modelChannel: "advisory",
    resumeStrategy: "session_resume_pending_smoke",
    mcpTransports: ["stdio", "sse", "http"],
    fsPolicy: "none",
  },
  {
    id: "mimo",
    capabilityAgent: "mimo",
    providerKinds: ["agent_native"],
    permissionPolicies: ["default"],
    binaryId: "mimo",
    launchCommandHint: ["mimo", "acp"],
    modelChannel: "advisory",
    resumeStrategy: "session_resume_pending_smoke",
    mcpTransports: ["stdio", "sse", "http"],
    fsPolicy: "none",
  },
] as const satisfies readonly AdapterSupport[];

export function getAdapterSupport(): readonly AdapterSupport[] {
  return ADAPTER_SUPPORT;
}

export function getAdapterSupportById(
  adapterId: string,
): AdapterSupport | undefined {
  return ADAPTER_SUPPORT.find((adapter) => adapter.id === adapterId);
}

export function providerKindsForAdapter(
  adapter: AdapterId,
): readonly ProviderKind[] {
  return getAdapterSupportById(adapter)?.providerKinds ?? [];
}

export function permissionPoliciesForAdapter(
  adapter: AdapterId,
): readonly PermissionPolicy[] {
  return getAdapterSupportById(adapter)?.permissionPolicies ?? [];
}
