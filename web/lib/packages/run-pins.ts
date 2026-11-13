import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, asc, eq, inArray, notInArray, or } from "drizzle-orm";

import {
  executionAssignments,
  executionCommands,
  runs,
  runSessionIncarnations,
  workspaces,
} from "@/lib/db/schema";
import { OPEN_COMMAND_STATES } from "@/lib/execution-host/types";
import { workbenchClaimHoldsTree } from "@/lib/runs/lifecycle-claim";
import { isTerminalRunStatus } from "@/lib/runs/run-status-sets";

export type PackageRunBlocker = {
  runId: string;
  status: string;
  reasons: string[];
};

/**
 * Attachment protection is distinct from immutable revision retention. Only an
 * ended Crashed run with every tree fully archived can release its recoverable
 * attachment pin; outcomes and revision references are never rewritten.
 *
 * Called inside the detach transaction. Run locks serialize recovery and the
 * lifecycle claim's status check. Read workspaces without locking: archive
 * finalization locks run then workspace, while reattach claims workspace then
 * run and cannot touch the filesystem until that claim commits.
 */
export async function lockPackageRunBlockers(
  db: Db,
  projectId: string,
  flowIds: string[],
  revisionIds: string[],
): Promise<PackageRunBlocker[]> {
  if (flowIds.length === 0 && revisionIds.length === 0) return [];
  const memberPin = or(
    inArray(runs.flowId, flowIds),
    inArray(runs.flowRevisionId, revisionIds),
  );
  const sharedRoots = db
    .select({ rootRunId: runs.rootRunId })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), memberPin));
  const related = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        or(
          memberPin,
          and(
            eq(runs.workspaceMode, "shared"),
            eq(runs.agentWorkspace, "worktree"),
            inArray(runs.rootRunId, sharedRoots),
          ),
        ),
      ),
    )
    .orderBy(asc(runs.id))
    .for("update");

  if (related.length === 0) return [];
  const runIds = related.map((run) => run.id);
  const trees = await db
    .select()
    .from(workspaces)
    .where(inArray(workspaces.runId, runIds));
  const assignments = await db
    .select({ runId: executionAssignments.runId })
    .from(executionAssignments)
    .where(
      and(
        inArray(executionAssignments.runId, runIds),
        eq(executionAssignments.state, "active"),
      ),
    );
  const sessions = await db
    .select({ runId: runSessionIncarnations.runId })
    .from(runSessionIncarnations)
    .where(
      and(
        inArray(runSessionIncarnations.runId, runIds),
        notInArray(runSessionIncarnations.state, [
          "exited",
          "crashed",
          "checkpointed",
          "deleted",
        ]),
      ),
    );
  const commands = await db
    .select({ runId: executionCommands.runId })
    .from(executionCommands)
    .where(
      and(
        inArray(executionCommands.runId, runIds),
        inArray(executionCommands.state, [...OPEN_COMMAND_STATES]),
      ),
    );
  const executing = new Set([
    ...assignments.map(({ runId }) => runId),
    ...sessions.map(({ runId }) => runId),
    ...commands.map(({ runId }) => runId),
  ]);
  const blockers: PackageRunBlocker[] = [];

  for (const run of related) {
    if (
      !flowIds.includes(run.flowId ?? "") &&
      !revisionIds.includes(run.flowRevisionId ?? "")
    )
      continue;
    const reasons: string[] = [];

    if (assignments.some(({ runId }) => runId === run.id))
      reasons.push("active_execution_assignment");
    if (sessions.some(({ runId }) => runId === run.id))
      reasons.push("session_not_quiescent");
    if (commands.some(({ runId }) => runId === run.id))
      reasons.push("execution_command_incomplete");
    if (run.status === "Crashed") {
      if (!run.endedAt) reasons.push("run_not_ended");
      if (!run.flowRevisionId) reasons.push("historical_revision_missing");
      const siblings =
        run.workspaceMode === "shared" &&
        run.agentWorkspace === "worktree" &&
        run.rootRunId
          ? related.filter(
              (other) =>
                other.rootRunId === run.rootRunId &&
                other.workspaceMode === "shared" &&
                other.agentWorkspace === "worktree",
            )
          : [run];
      const owners = new Set(siblings.map(({ id }) => id));
      const runTrees = trees.filter(({ runId }) => owners.has(runId));

      if (
        runTrees.length === 0 ||
        runTrees.some((tree) => !tree.archivedAt || !tree.removedAt)
      )
        reasons.push("workspace_not_archived");
      // Clean archives need no ref. Pre-outcome records remain compatible
      // only when both retained Git references prove preservation was recorded.
      if (
        runTrees.some(
          (tree) =>
            tree.preservationOutcome !== "not_needed" &&
            (!tree.archivedBranch || !tree.archivedCommit),
        )
      )
        reasons.push("workspace_preservation_incomplete");
      if (
        runTrees.some(
          (tree) =>
            tree.lifecycleOperationState !== "none" ||
            workbenchClaimHoldsTree(tree),
        )
      )
        reasons.push("lifecycle_operation_incomplete");
      if (
        siblings.some(
          (other) =>
            other.id !== run.id &&
            (!isTerminalRunStatus(other.status) ||
              !other.endedAt ||
              executing.has(other.id)),
        )
      )
        reasons.push("shared_workspace_not_quiescent");
    } else if (!isTerminalRunStatus(run.status)) {
      reasons.push("run_requires_package");
    }
    if (reasons.length > 0)
      blockers.push({ runId: run.id, status: run.status, reasons });
  }

  return blockers;
}
