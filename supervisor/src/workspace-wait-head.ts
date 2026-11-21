import type {
  WaitHeadObservation,
  WaitHeadObservationRequest,
} from "../../runtime/wait-head";
import type {
  HostState,
  WorkspaceRow,
  WorkspaceWaitWitness,
} from "./host-state";
import type { CommandFence } from "./types";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GIT_OBJECT_ID } from "../../runtime/wait-head";

import { SupervisorError } from "./types";

const exec = promisify(execFile);

function refused(runId: string): SupervisorError {
  return new SupervisorError(
    "FENCED",
    "Wait workspace witness no longer applies",
    {
      details: { reason: "assignment_fenced", runId },
    },
  );
}

export function requireWaitWorkspaceFence(
  state: HostState,
  handle: WorkspaceRow,
  fence: CommandFence,
): void {
  const current = state.getFence(fence.runId);

  if (
    fence.hostKey !== state.hostKey ||
    fence.runId !== handle.runId ||
    !current ||
    current.epoch !== fence.assignmentEpoch ||
    current.assignmentId !== fence.assignmentId ||
    handle.releasedAt !== null ||
    handle.kind !== "git_worktree"
  )
    throw refused(fence.runId);
}

export async function observeWaitWorkspaceHead(
  state: HostState,
  handle: WorkspaceRow,
  fence: CommandFence,
  request: WaitHeadObservationRequest,
): Promise<WaitHeadObservation> {
  requireWaitWorkspaceFence(state, handle, fence);

  const witness = state.getWorkspaceWait(request.waitId);
  const matches = (row: WorkspaceWaitWitness) =>
    row.workspaceId === handle.id &&
    row.runId === fence.runId &&
    row.assignmentId === fence.assignmentId &&
    row.generation === request.workspaceGeneration;

  if (
    request.workspaceGeneration !== fence.assignmentEpoch ||
    (witness && !matches(witness)) ||
    (!witness && !request.register)
  )
    throw refused(fence.runId);
  if (witness && request.register) return { headSha: witness.headSha };

  let headSha: string;

  try {
    const result = await exec(
      "git",
      [
        "--no-pager",
        "--no-optional-locks",
        "-C",
        handle.realPath,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ],
      {
        encoding: "utf8",
        timeout: 4000,
        maxBuffer: 1024,
      },
    );

    headSha = result.stdout.trim();
  } catch (error: unknown) {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "Could not observe the adopted Git HEAD",
      {
        cause: error instanceof Error ? error : undefined,
      },
    );
  }

  if (!GIT_OBJECT_ID.test(headSha)) throw refused(fence.runId);

  const retainedHandle = state.getWorkspace(handle.id);

  if (!retainedHandle) throw refused(fence.runId);
  requireWaitWorkspaceFence(state, retainedHandle, fence);

  if (!request.register) return { headSha };

  state.insertWorkspaceWait({
    waitId: request.waitId,
    workspaceId: handle.id,
    runId: fence.runId,
    assignmentId: fence.assignmentId,
    generation: request.workspaceGeneration,
    headSha,
  });
  const retained = state.getWorkspaceWait(request.waitId);

  if (!retained || !matches(retained)) throw refused(fence.runId);

  return { headSha: retained.headSha };
}
