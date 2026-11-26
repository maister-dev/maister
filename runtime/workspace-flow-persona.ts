export const WORKSPACE_FLOW_PERSONAS_FILE = "flow-personas.json";
export const WORKSPACE_FLOW_PERSONAS_MAX_BYTES = 256 * 1024;
export const WORKSPACE_FLOW_ROLE_STEM =
  /^(?!\.{1,2}$)(?!.*\.\.)[A-Za-z0-9._-]+$/u;

export type WorkspaceClaudeSubagent = Readonly<{
  stem: string;
  description: string;
  prompt: string;
}>;

export type WorkspaceFlowPersona = Readonly<{
  stepId: string;
  agentId: string;
  packageName: string;
  packageInstallId: string;
  definitionSha256: string;
  mode: "session" | "subagent";
  stem: string;
  description: string;
  prompt: string;
}>;
