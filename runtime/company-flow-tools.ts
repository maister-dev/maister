/** Company graph credentials expose only currently reviewed native knowledge and assignment-context actions. */
export const COMPANY_FLOW_MCP_SERVER = "maister";
export const COMPANY_FLOW_TOOL_CONTRACT = [
  { name: "knowledge_search", scope: "knowledge:read" },
  { name: "knowledge_get", scope: "knowledge:read" },
  { name: "knowledge_evidence", scope: "knowledge:read" },
  { name: "knowledge_conflicts", scope: "knowledge:read" },
  { name: "knowledge_witness_get", scope: "knowledge:read" },
  { name: "knowledge_proposal_get", scope: "knowledge:read" },
  { name: "knowledge_capture_source", scope: "knowledge:propose" },
  { name: "knowledge_propose", scope: "knowledge:propose" },
  { name: "assignment_context_get", scope: "assignments:read" },
  { name: "assignment_context_update", scope: "assignments:update" },
] as const;
export const COMPANY_FLOW_TOKEN_SCOPES = [
  ...new Set(COMPANY_FLOW_TOOL_CONTRACT.map((tool) => tool.scope)),
];
export type CompanyFlowKnowledgeScope =
  (typeof COMPANY_FLOW_TOOL_CONTRACT)[number]["scope"];
export type CompanyFlowToolName =
  (typeof COMPANY_FLOW_TOOL_CONTRACT)[number]["name"];

/** Server-owned MCP-only policy; no built-in, confirmation or ambient memory tool is admitted. */
export function companyFlowEnforcementProfile(
  scopes: readonly CompanyFlowKnowledgeScope[],
): {
  tools: { allow: string[] };
  mcps: { allowServers: string[] };
  enforcedClasses: ("tools" | "mcps")[];
  escalationThreshold: number;
  allowedToolApproval: "execution_policy";
} {
  const allow = COMPANY_FLOW_TOOL_CONTRACT.filter((tool) =>
    scopes.includes(tool.scope),
  ).map((tool) => `mcp__${COMPANY_FLOW_MCP_SERVER}__${tool.name}`);

  return {
    tools: { allow },
    mcps: { allowServers: allow.length > 0 ? [COMPANY_FLOW_MCP_SERVER] : [] },
    enforcedClasses: ["tools", "mcps"],
    escalationThreshold: 3,
    allowedToolApproval: "execution_policy",
  };
}
