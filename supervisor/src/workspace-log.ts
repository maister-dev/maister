import type {
  WorkspaceEvidenceObject,
  WorkspaceLogPage,
  WorkspaceLogQuery,
} from "../../runtime/workspace-prepare";
import type { HostState } from "./host-state";
import type { RuntimeEventPublisher } from "./runtime-event-publisher";
import type { RuntimeObjectRegistry } from "./runtime-objects";

import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import {
  WORKSPACE_LOG_MAX_BYTES,
  WORKSPACE_LOG_OBJECT_NAME,
  workspaceEvidenceDigest,
} from "../../runtime/workspace-prepare";

import { isSupervisorError, SupervisorError } from "./types";
import { sealWorkspaceOutput } from "./workspace-output-object";
import { executeWorkspaceGitBytes } from "./workspace-source";
import {
  loadPreparedWorkspace,
  observePreparedGitHead,
} from "./workspace-status";

function readOffset(cursor: string | undefined, scope: string): number {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(cursor, "base64url");
  const content = decoded.toString("utf8");
  const position = content.slice(scope.length);
  if (
    decoded.toString("base64url") !== cursor ||
    !content.startsWith(scope) ||
    !/^[1-9][0-9]{0,8}$/.test(position)
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Git log cursor belongs to a different checkout or HEAD",
      {
        details: { reason: "workspace_log_cursor_invalid" },
      },
    );

  return Number(position);
}

function oversizedLog(): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    "Git log page exceeds 64 KiB. Use a smaller page size",
    {
      details: { reason: "workspace_log_too_large" },
    },
  );
}

/** Seal an immutable page of commit history reachable from the owned checkout's exact HEAD. */
export async function sealWorkspaceLog(
  services: Readonly<{
    state: HostState;
    objects: RuntimeObjectRegistry;
    events: RuntimeEventPublisher;
  }>,
  query: WorkspaceLogQuery & Readonly<{ handle: string }>,
): Promise<WorkspaceEvidenceObject | null> {
  const { state } = services;
  const { handle, generation, limit = 20 } = query;
  const owned = loadPreparedWorkspace(state, handle, generation);
  if (!owned) return null;
  const { workspace } = owned;
  const fence = state.getFence(workspace.runId);
  if (!fence || workspace.kind !== "git_worktree")
    throw new SupervisorError(
      "PRECONDITION",
      "The workspace has no verified Git history",
      {
        details: { reason: "workspace_rejected" },
      },
    );

  let page: WorkspaceLogPage;
  try {
    const observed = await observePreparedGitHead(workspace);
    const scope = `${workspaceEvidenceDigest([state.hostKey, handle, generation, observed.commit])}:`;
    const offset = readOffset(query.cursor, scope);
    const records = await executeWorkspaceGitBytes(
      [
        "--no-optional-locks",
        "--no-replace-objects",
        "-C",
        workspace.realPath,
        "log",
        "--topo-order",
        "--no-show-signature",
        "--no-decorate",
        "--no-notes",
        "-z",
        "--format=%H%x00%cI%x00%s",
        `--skip=${offset}`,
        `--max-count=${limit + 1}`,
        observed.commit,
        "--",
      ],
      { timeout: 8_000 },
    );
    const fields = records.toString("utf8").split("\0");
    if (
      fields.pop() !== "" ||
      fields.length % 3 !== 0 ||
      fields.length > 3 * (limit + 1)
    )
      throw new SupervisorError(
        "ACP_PROTOCOL",
        "Git returned an invalid log page",
      );
    const commits: WorkspaceLogPage["commits"][number][] = [];
    for (
      let index = 0;
      index < Math.min(3 * limit, fields.length);
      index += 3
    ) {
      const [commit, committedAt, subject] = fields.slice(index, index + 3);
      if (
        !GIT_OBJECT_ID.test(commit) ||
        !Number.isFinite(Date.parse(committedAt))
      )
        throw new SupervisorError(
          "ACP_PROTOCOL",
          "Git returned invalid commit metadata",
        );
      commits.push({ commit, committedAt, subject });
    }

    const verified = await observePreparedGitHead(workspace);
    const currentFence = state.getFence(workspace.runId);
    if (
      verified.commit !== observed.commit ||
      verified.ref !== observed.ref ||
      !loadPreparedWorkspace(state, handle, generation) ||
      currentFence?.assignmentId !== fence.assignmentId ||
      currentFence.epoch !== fence.epoch
    )
      throw new SupervisorError(
        "FENCED",
        "Checkout identity changed during Git log inspection",
        {
          details: { reason: "stale_workspace_generation" },
        },
      );
    page = {
      head: observed.commit,
      commits,
      nextCursor:
        fields.length > 3 * limit
          ? Buffer.from(`${scope}${offset + limit}`).toString("base64url")
          : null,
    };
  } catch (error) {
    if (isSupervisorError(error)) throw error;
    if (
      (error as NodeJS.ErrnoException).code ===
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      throw oversizedLog();
    // Git errors can contain the private path or source configuration.
    throw new SupervisorError(
      "PRECONDITION",
      "The supervisor could not verify workspace Git history",
      {
        details: { reason: "workspace_rejected" },
      },
    );
  }

  const bytes = Buffer.from(JSON.stringify(page));
  if (bytes.byteLength > WORKSPACE_LOG_MAX_BYTES) throw oversizedLog();
  const object = await sealWorkspaceOutput(
    services,
    {
      runId: workspace.runId,
      assignmentId: fence.assignmentId,
      assignmentEpoch: fence.epoch,
    },
    {
      logicalName: WORKSPACE_LOG_OBJECT_NAME,
      mimeType: "application/json",
      bytes,
      source: { workspaceGitLog: { handle, generation, head: page.head } },
    },
  );

  return { generation, object };
}
