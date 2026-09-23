import { MaisterError } from "@/lib/errors-core";

// ADR-181 D9: what the branch is updated onto.
export type SyncOnto = "target" | "base" | "published";

// ADR-181 D9: what an update applies onto. `ref` is what git reads; `label` is
// what the attempt records as `target_ref` (`<branch>` or `<remote>/<public>`).
export type SyncRef =
  | { kind: "branch"; branch: string; ref: string; label: string }
  | {
      kind: "published";
      remote: string;
      branch: string;
      ref: string;
      label: string;
    };

// ADR-181 D9 — the ONE mapping of `onto` to a ref: the update resolves it
// before any claim (so a refused update leaves no attempt behind), and the git
// read model counts ahead/behind against the same refs. Pure.
export function resolveSyncRef(
  onto: SyncOnto,
  runId: string,
  workspace: {
    targetBranch?: string | null;
    baseBranch?: string | null;
    publishedBranch?: string | null;
    publishedRemote?: string | null;
  },
  project: { mainBranch?: string | null } | null,
): SyncRef {
  if (onto === "base") {
    if (!workspace.baseBranch) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} records no base branch — update onto the target or the publication instead`,
        { details: { reason: "base_branch_unknown" } },
      );
    }

    return {
      kind: "branch",
      branch: workspace.baseBranch,
      ref: workspace.baseBranch,
      label: workspace.baseBranch,
    };
  }

  if (onto === "published") {
    if (!workspace.publishedBranch || !workspace.publishedRemote) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} is not published — publish it before updating from the publication`,
        { details: { reason: "not_published" } },
      );
    }

    return {
      kind: "published",
      remote: workspace.publishedRemote,
      branch: workspace.publishedBranch,
      ref: `refs/remotes/${workspace.publishedRemote}/${workspace.publishedBranch}`,
      label: `${workspace.publishedRemote}/${workspace.publishedBranch}`,
    };
  }

  const target = workspace.targetBranch ?? project?.mainBranch ?? "main";

  return { kind: "branch", branch: target, ref: target, label: target };
}
