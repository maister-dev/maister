import path from "node:path";

import { worktreesRoot } from "@/lib/instance-config";

export function agentWorkdirPath(projectSlug: string, runId: string): string {
  return path.join(worktreesRoot(), projectSlug, runId);
}

/** Project-owned directory for shared checkouts and their allocation mutex. */
export function sharedAgentWorktreesDirectory(projectSlug: string): string {
  return path.join(worktreesRoot(), projectSlug, "agents");
}

/** Shared writable checkout for the existing orchestrator tree root. */
export function sharedAgentWorktreePath(
  projectSlug: string,
  rootRunId: string,
): string {
  return path.join(sharedAgentWorktreesDirectory(projectSlug), rootRunId);
}

/** Ephemeral read-only checkout pinned to the trigger-derived reference. */
export function agentReadOnlyWorkdirPath(
  projectSlug: string,
  runId: string,
): string {
  return path.join(worktreesRoot(), projectSlug, `${runId}-ro`);
}
