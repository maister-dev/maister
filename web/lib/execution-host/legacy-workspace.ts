import { MaisterError } from "@/lib/errors";

export type LegacyWorkspacePaths = {
  worktreePath: string;
  parentRepoPath: string;
};

export function hasLegacyWorkspacePaths<
  T extends {
    worktreePath: string | null;
    parentRepoPath: string | null;
  },
>(workspace: T): workspace is T & LegacyWorkspacePaths {
  return (
    typeof workspace.worktreePath === "string" &&
    typeof workspace.parentRepoPath === "string"
  );
}

export function requireLegacyWorkspacePaths<
  T extends {
    worktreePath: string | null;
    parentRepoPath: string | null;
  },
>(workspace: T): T & LegacyWorkspacePaths {
  if (!hasLegacyWorkspacePaths(workspace)) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The operation needs a workspace on its owning supervisor",
      { details: { reason: "workspace_protocol_unsupported" } },
    );
  }

  return workspace;
}
