import { MaisterError } from "@/lib/errors-core";

// ADR-160: the readiness contract for taking a finished `Review` run back for
// rework. Deliberately NOT shared with ADR-141's `assertSyncEligible`, whose
// terms this copies: sync is a BRANCH operation (it needs only a worktree and a
// branch, which an agent run has), while a rework claim is a GRAPH RE-ENTRY
// operation. Reusing one predicate across two concerns without re-deriving each
// term is the failure mode this project has already paid for, so the divergence
// is written out rather than abstracted away.
export type ReworkClaimEligibilityRun = {
  status: string;
  runKind: string;
  parentRunId: string | null;
  workspaceMode: string | null;
  // A launched evaluation participant (ADR-150 launched-lineage membership).
  isLaunchedLineage: boolean;
};

/**
 * Allow-list gate. Every term must hold; a status this does not name is
 * refused by default rather than falling through to admission.
 */
export function assertReworkClaimEligible(
  run: ReworkClaimEligibilityRun,
  workspace: { removedAt: Date | null } | null,
): void {
  if (run.status !== "Review") {
    throw new MaisterError(
      "PRECONDITION",
      `run must be Review to take for rework (is ${run.status})`,
    );
  }

  // NARROWER than sync on purpose: an agent run's stepId is the constant
  // "agent" and it carries no node_attempts rows at all, so there is no node to
  // anchor the claim on, no re-entry node to resolve, nothing to stale, and no
  // runGraph traversal to resume. Refuse early with the alternatives named.
  if (run.runKind !== "flow") {
    throw new MaisterError(
      "PRECONDITION",
      `only flow runs can be taken for rework (is ${run.runKind}) — a non-flow run has no graph to re-enter; use branch sync, or launch a new run from this branch`,
    );
  }

  if (run.parentRunId !== null) {
    throw new MaisterError(
      "PRECONDITION",
      "an orchestrator child run cannot be taken for rework — claiming it would un-settle a parked parent",
    );
  }

  if (run.workspaceMode === "shared") {
    throw new MaisterError(
      "PRECONDITION",
      "a shared-tree run cannot be taken for rework — the tree is one branch",
    );
  }

  if (run.isLaunchedLineage) {
    throw new MaisterError(
      "PRECONDITION",
      "a launched evaluation participant cannot be taken for rework — decide the study first",
    );
  }

  if (workspace === null) {
    throw new MaisterError(
      "PRECONDITION",
      "the run has no workspace — nothing to take for rework",
    );
  }

  if (workspace.removedAt !== null) {
    throw new MaisterError(
      "PRECONDITION",
      "the run workspace was removed — nothing to take for rework",
    );
  }
}
