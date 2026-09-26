// Named tool subsets a facade process may expose (`MAISTER_MCP_TOOLSET`).
// Listing is a convenience for the model; every refusal is still enforced by
// the ext routes (ADR-184: a librarian token is refused on any route that does
// not admit it). Mirrored by `web/lib/librarian/toolset.ts`, whose drift test
// imports this file.

// ADR-184 / ADR-185: the tools a librarian turn may call. Human-only decisions
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
  "task_update",
  "flow_list",
  "runner_list",
  "memory_recall",
  "run_launch",
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
  librarian: LIBRARIAN_TOOLSET,
} as const satisfies Record<string, readonly string[]>;

export type ToolsetName = keyof typeof TOOLSETS;

export function isToolsetName(value: string | undefined): value is ToolsetName {
  return value !== undefined && Object.hasOwn(TOOLSETS, value);
}
