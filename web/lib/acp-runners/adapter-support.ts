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

// Capability-token surface forms, frozen 2026-06-16 vs the installed CLIs
// (acp-runners.md §"Per-adapter materialization target" / flow-settings.md
// FROZEN SPEC). The cross-runner normalizer (token-normalizer.ts) reads these
// table-driven — never a claude/codex constant.
export type CapabilitySurface = {
  /** Does the adapter surface project skills at all (materialized/discovered)? */
  readonly skills: boolean;
  /** Does the adapter honor coder subagents (the `@name` wire form)? */
  readonly subagents: boolean;
  /** Wire sigil a skill is invoked with in a prompt for this adapter. */
  readonly skillSigil: "/" | "$";
};

// Per-adapter materialization target (acp-runners.md §"Per-adapter
// materialization target", FR-C1/T0.4). `cwd-dir` writes a worktree-relative
// dir the agent auto-discovers from cwd (claude `.claude/`, gemini `.gemini/`);
// `home-redirect` writes a per-session dir and points the agent at it via
// `redirectEnv` on spawn. Frozen 2026-06-16 vs the installed CLIs.
export type AdapterMaterialization = {
  readonly mode: "cwd-dir" | "home-redirect";
  /** cwd-relative subdir (cwd-dir) or per-session subdir name (home-redirect). */
  readonly dir: string;
  /** env var the spawn sets to relocate the agent's home (home-redirect only). */
  readonly redirectEnv?: string;
};

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
  readonly capabilitySurface: CapabilitySurface;
  readonly materialization: AdapterMaterialization;
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
    capabilitySurface: { skills: true, subagents: true, skillSigil: "/" },
    materialization: { mode: "cwd-dir", dir: ".claude" },
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
    capabilitySurface: { skills: true, subagents: false, skillSigil: "$" },
    materialization: {
      mode: "home-redirect",
      dir: "codex-home",
      redirectEnv: "CODEX_HOME",
    },
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
    capabilitySurface: { skills: true, subagents: false, skillSigil: "/" },
    materialization: { mode: "cwd-dir", dir: ".gemini" },
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
    capabilitySurface: { skills: true, subagents: false, skillSigil: "/" },
    materialization: {
      mode: "home-redirect",
      dir: "opencode-home",
      redirectEnv: "OPENCODE_CONFIG_DIR",
    },
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
    capabilitySurface: { skills: true, subagents: false, skillSigil: "/" },
    materialization: {
      mode: "home-redirect",
      dir: "mimo-home",
      redirectEnv: "XDG_CONFIG_HOME",
    },
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

const DEFAULT_CAPABILITY_SURFACE: CapabilitySurface = {
  skills: true,
  subagents: false,
  skillSigil: "/",
};

export function capabilitySurfaceFor(agent: string): CapabilitySurface {
  return (
    getAdapterSupportById(agent)?.capabilitySurface ??
    DEFAULT_CAPABILITY_SURFACE
  );
}
