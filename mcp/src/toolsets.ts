import {
  installationToolNames,
  INSTALLATION_SCOPE_TOOLS,
} from "../../runtime/installation-agent-tools";
import { COMPANY_FLOW_TOOL_CONTRACT } from "../../runtime/company-flow-tools";
import { PERSONAL_KNOWLEDGE_TOOLS } from "../../runtime/knowledge-tool-effects";

// Named tool subsets a facade process may expose (`MAISTER_MCP_TOOLSET`).
// Listing is a convenience for the model; every refusal is still enforced by
// the ext routes (ADR-186: a librarian token is refused on any route that does
// not admit it). The company subset shares the native runtime contract; the
// librarian list is mirrored by web/lib/librarian/toolset.ts and drift-checked.

// ADR-186 / ADR-187: the tools a librarian turn may call. Human-only decisions
// (`hitl_respond`, `run_promote`, `run_discard`), coordinator tools
// (`run_delegate`, `run_collect`, `run_cancel`, `run_rework`, `run_message`,
// `run_plan`), the triager's verdict (`triage_set`) and every agent-memory,
// Brain-write and evaluation tool are deliberately absent.
export const LIBRARIAN_TOOLSET = [
  "project_list",
  "project_get",
  "task_search",
  "work_list",
  "decisions_list",
  "activity_feed",
  "task_list",
  "task_get",
  "task_create",
  "task_statement_accept",
  "task_send_to_triage",
  "task_publish_excerpt",
  "clarification_request",
  "clarification_cancel",
  "clarification_list",
  "project_members_list",
  "task_update",
  "flow_list",
  "runner_list",
  "memory_recall",
  "knowledge_search",
  "knowledge_get",
  "knowledge_evidence",
  "knowledge_witness_get",
  "knowledge_conflicts",
  "knowledge_propose",
  "memory_propose",
  "agent_vault_list",
  "agent_vault_view",
  "agent_vault_search",
  "agent_vault_backlinks",
  "agent_vault_tags",
  "agent_vault_propose_edit",
  "run_launch",
  "task_launch",
  "task_launch_options",
  "task_launch_status",
  "task_launch_cancel",
  "task_launch_replace",
  "run_stop",
  "run_operator_message",
  "librarian_card_propose",
  "librarian_memory_remember",
  "librarian_history_search",
  "run_get",
  "run_activity",
  "readiness_get",
  "run_recover",
  "run_sync",
  "run_reopen",
  "hitl_list",
  "hitl_inbox",
  "comment_list",
  "comment_create",
  "relation_list",
  "relation_add",
  "relation_remove",
] as const;

export const TOOLSETS = {
  company: COMPANY_FLOW_TOOL_CONTRACT.map((tool) => tool.name),
  librarian: LIBRARIAN_TOOLSET,
  installation: installationToolNames(Object.keys(INSTALLATION_SCOPE_TOOLS)),
  "personal-knowledge": [
    ...PERSONAL_KNOWLEDGE_TOOLS,
    "knowledge_search", "knowledge_get", "knowledge_evidence", "knowledge_conflicts",
    "knowledge_witness_get", "knowledge_propose", "knowledge_proposals_list", "knowledge_proposal_get",
    "knowledge_decide", "knowledge_confirm",
  ],
  vault: [
    "memory",
    "agent_memory_write",
    "memory_search",
    "memory_backlinks",
    "memory_tags",
  ],
} as const satisfies Record<string, readonly string[]>;

export type ToolsetName = keyof typeof TOOLSETS;

export function isToolsetName(value: string | undefined): value is ToolsetName {
  return value !== undefined && Object.hasOwn(TOOLSETS, value);
}
