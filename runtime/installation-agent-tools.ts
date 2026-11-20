/** Capability mapping shared by the session launcher and its bundled MCP process. */
export const INSTALLATION_SCOPE_TOOLS = {
  "projects:read": ["project_list", "project_get"],
  "tasks:read": ["task_list", "task_get"],
  "runs:read": ["run_get"],
  "activity:read": ["run_activity"],
  "observatory:read": ["observatory_summary"],
  "memory:read": ["memory_recall"],
  "memory:propose": ["memory_propose"],
  "knowledge:read": ["knowledge_search", "knowledge_get"],
  "knowledge:propose": ["knowledge_propose"],
  "agent_memory:read": [
    "memory",
    "memory_search",
    "memory_backlinks",
    "memory_tags",
  ],
  "agent_memory:propose": ["memory", "memory_promote"],
} as const;

export type InstallationScope = keyof typeof INSTALLATION_SCOPE_TOOLS;

export function installationToolNames(scopes: readonly string[]): string[] {
  return [
    ...new Set(
      scopes.flatMap((scope) =>
        Object.hasOwn(INSTALLATION_SCOPE_TOOLS, scope)
          ? INSTALLATION_SCOPE_TOOLS[scope as InstallationScope]
          : [],
      ),
    ),
  ];
}

export function installationEnforcementProfile(scopes: readonly string[]) {
  const allow = installationToolNames(scopes).map(
    (tool) => `mcp__maister__${tool}`,
  );
  const enforcedClasses: ("tools" | "mcps")[] = ["tools", "mcps"];

  return {
    tools: { allow },
    mcps: { allowServers: allow.length ? ["maister"] : [] },
    enforcedClasses,
    escalationThreshold: 3,
    allowedToolApproval: "execution_policy" as const,
  };
}
