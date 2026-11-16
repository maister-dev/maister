import { createHash } from "node:crypto";
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

/** Mutable native adapter homes are outside the operational source checkout. */
export function operationalAgentRuntimePath(
  projectSlug: string,
  runId: string,
): string {
  return path.join(worktreesRoot(), projectSlug, `${runId}-runtime`);
}

/** Opaque company/run identities cannot escape or alias a project run directory. */
export function companyAgentWorkdirPath(
  companyId: string,
  runId: string,
): string {
  const owner = createHash("sha256")
    .update(JSON.stringify([companyId, runId]))
    .digest("hex");

  return path.join(worktreesRoot(), ".company", owner);
}

/** Mutable adapter state remains separate from the company's source witness. */
export function companyAgentRuntimePath(
  companyId: string,
  runId: string,
): string {
  return `${companyAgentWorkdirPath(companyId, runId)}-runtime`;
}
