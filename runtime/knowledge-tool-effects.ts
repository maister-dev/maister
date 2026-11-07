/** Native facade effects are platform contracts, never model-supplied annotations. */
export const NATIVE_KNOWLEDGE_TOOL_EFFECTS = {
  assignment_context_get: "read",
  knowledge_search: "read",
  knowledge_get: "read",
  knowledge_evidence: "read",
  knowledge_conflicts: "read",
  knowledge_witness_get: "read",
  knowledge_proposal_get: "read",
  knowledge_proposals_list: "read",
  knowledge_capture_source: "write",
  knowledge_propose: "write",
  knowledge_decide: "write",
  knowledge_confirm: "write",
} as const;

export function isNativeKnowledgeReadTool(name: string): boolean {
  return (
    Object.hasOwn(NATIVE_KNOWLEDGE_TOOL_EFFECTS, name) &&
    NATIVE_KNOWLEDGE_TOOL_EFFECTS[
      name as keyof typeof NATIVE_KNOWLEDGE_TOOL_EFFECTS
    ] === "read"
  );
}
