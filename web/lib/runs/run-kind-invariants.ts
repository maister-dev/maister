import type { RunKind } from "@/lib/db/schema";
import type { DelegationSnapshot } from "@/lib/db/schema";

import { MaisterError } from "@/lib/errors";

export type RunKindInvariantInput = {
  id?: string;
  runKind: RunKind;
  taskId: string | null;
  flowId: string | null;
  flowRevisionId: string | null;
  flowVersion: string;
  flowRevision: string;
  agentId?: string | null;
  delegationSnapshot?: DelegationSnapshot | null;
};

export type RunScratchMetadataInvariantInput = {
  runKind: RunKind;
  scratchRunId: string | null;
  // M36 Phase 5 (ADR-097): a scratch run owner is EXACTLY ONE of project /
  // local-package. The project-less (local-package) variant is the docked
  // authoring assistant rooted at a working dir; it has projectId=null +
  // localPackageId set. Omitted (undefined) on the legacy call sites = treated
  // as the project variant (projectId present).
  projectId?: string | null;
  localPackageId?: string | null;
};

const RUN_KIND_INVARIANTS = {
  flow: assertFlowRunInvariant,
  agent: assertAgentRunInvariant,
  scratch: assertScratchRunInvariant,
  librarian: assertLibrarianRunInvariant,
} satisfies Record<RunKind, (input: RunKindInvariantInput) => void>;

export function assertRunKindInvariant(input: RunKindInvariantInput): void {
  RUN_KIND_INVARIANTS[input.runKind](input);
}

/** Narrows a project-scoped row's `runKind` (see `asProjectRunKind`). */
export function withProjectRunKind<
  T extends { runKind: RunKind; runId?: string },
>(row: T): Omit<T, "runKind"> & { runKind: ProjectRunKind } {
  return { ...row, runKind: asProjectRunKind(row.runKind, row.runId) };
}

/** Every run kind that can belong to a project. */
export type ProjectRunKind = Exclude<RunKind, "librarian">;

/** A row read through a project (`runs.project_id = …` or an inner join to
 * `projects`) can never be a librarian run: `runs_librarian_shape_check` keeps
 * its `project_id` NULL. Reaching the throw means that invariant broke. */
export function asProjectRunKind(
  kind: RunKind,
  runId?: string,
): ProjectRunKind {
  if (kind === "librarian")
    throw new MaisterError(
      "CONFIG",
      `run ${runId ?? "?"} is a librarian run on a project-scoped path`,
    );

  return kind;
}

export function assertRunScratchMetadataInvariant(
  input: RunScratchMetadataInvariantInput,
): void {
  if (input.runKind === "scratch" && !input.scratchRunId) {
    throw new MaisterError(
      "CONFIG",
      "scratch run requires scratch_runs metadata",
    );
  }

  if (input.runKind === "flow" && input.scratchRunId) {
    throw new MaisterError(
      "CONFIG",
      "flow run must not have scratch_runs metadata",
    );
  }

  // ADR-097 XOR: a scratch run is owned by EXACTLY ONE of project /
  // local-package. Only enforced when a caller supplies the owner pair (legacy
  // call sites that pass neither are the project variant by construction and
  // skip this check; the DB CHECK is the backstop on every row).
  if (
    input.runKind === "scratch" &&
    (input.projectId !== undefined || input.localPackageId !== undefined)
  ) {
    const hasProject = Boolean(input.projectId);
    const hasLocalPackage = Boolean(input.localPackageId);

    if (hasProject === hasLocalPackage) {
      throw new MaisterError(
        "CONFIG",
        "scratch run requires exactly one of projectId / localPackageId",
      );
    }
  }

  // A non-scratch run is never owned by a local package.
  if (input.runKind !== "scratch" && input.localPackageId) {
    throw new MaisterError(
      "CONFIG",
      `${input.runKind} run must not store localPackageId`,
    );
  }
}

// M36 Phase 5 (ADR-097): `runs.project_id` is nullable ONLY for the project-less
// scratch-at-local-package assistant run. Flow/agent/project-scratch code paths
// never see that variant, so they narrow `string | null` → `string` here. A null
// is an internal invariant breach (a project-less run reaching a project-scoped
// path), surfaced as CONFIG, never silently coerced.
export function requireRunProjectId(
  projectId: string | null,
  runId?: string,
): string {
  if (!projectId) {
    throw new MaisterError(
      "CONFIG",
      `run ${runId ?? "?"} has no project (project-less local-package run reached a project-scoped path)`,
    );
  }

  return projectId;
}

function assertFlowRunInvariant(input: RunKindInvariantInput): void {
  if (!input.taskId || !input.flowId) {
    throw new MaisterError("CONFIG", "flow run requires taskId and flowId");
  }
}

// M34 (ADR-089): agent runs carry the catalog identity instead of a flow;
// taskId is optional (task-bound triage/commentary vs standalone monitors).
function assertAgentRunInvariant(input: RunKindInvariantInput): void {
  if (!input.agentId && input.delegationSnapshot?.kind !== "runner") {
    throw new MaisterError("CONFIG", "agent run requires agentId");
  }

  if (input.flowId || input.flowRevisionId) {
    throw new MaisterError(
      "CONFIG",
      "agent run must not store flowId or flowRevisionId on runs",
    );
  }

  if (input.flowVersion !== "agent" || input.flowRevision !== "manual") {
    throw new MaisterError(
      "CONFIG",
      "agent run requires flowVersion=agent and flowRevision=manual",
    );
  }
}

// ADR-183: the librarian run is the conversation's cache, never a unit of work.
function assertLibrarianRunInvariant(input: RunKindInvariantInput): void {
  if (input.taskId || input.flowId || input.flowRevisionId || input.agentId) {
    throw new MaisterError(
      "CONFIG",
      "librarian run must not store taskId, flowId, flowRevisionId or agentId",
    );
  }

  if (input.flowVersion !== "librarian") {
    throw new MaisterError(
      "CONFIG",
      "librarian run requires flowVersion=librarian",
    );
  }
}

function assertScratchRunInvariant(input: RunKindInvariantInput): void {
  if (input.taskId || input.flowId || input.flowRevisionId) {
    throw new MaisterError(
      "CONFIG",
      "scratch run must not store taskId, flowId, or flowRevisionId on runs",
    );
  }

  if (input.flowVersion !== "scratch" || input.flowRevision !== "manual") {
    throw new MaisterError(
      "CONFIG",
      "scratch run requires flowVersion=scratch and flowRevision=manual",
    );
  }
}
