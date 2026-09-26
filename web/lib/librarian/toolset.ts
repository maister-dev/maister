// ADR-184 / ADR-185: the librarian's tools — ONE list that feeds the
// instructions, the facade's `MAISTER_MCP_TOOLSET=librarian` listing (mirrored
// in `mcp/src/toolsets.ts`) and the supervisor L1 allow-list. The drift test
// imports the facade's copy and fails on any difference.
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
  "task_update",
  "flow_list",
  "runner_list",
  "memory_recall",
  "run_launch",
  "run_stop",
  "run_operator_message",
  "librarian_card_propose",
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

export type LibrarianTool = (typeof LIBRARIAN_TOOLSET)[number];

/** The MCP server name the librarian's facade is attached under. */
export const LIBRARIAN_MCP_SERVER = "maister";

/** The ACP tool names the supervisor's L1 guard admits (`tools.allow`). */
export function librarianAllowedToolNames(): string[] {
  return LIBRARIAN_TOOLSET.map(
    (tool) => `mcp__${LIBRARIAN_MCP_SERVER}__${tool}`,
  );
}
