import "server-only";

import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  getPrState,
  selectPrAdapter,
  type PrAdapter,
} from "@/lib/runs/pr-adapter";
import {
  detectProvider,
  readRemoteOrigin,
  type Provider,
} from "@/lib/repo-source";

const log = pino({
  name: "workbench-git-pr",
  level: process.env.LOG_LEVEL ?? "info",
});

type PullRequestProject = {
  repoUrl?: string | null;
  provider?: string | null;
} | null;

// ADR-181 D11 — the ONE provider resolution for a pull request: the project's
// recorded remote (else the parent checkout's origin), its recorded provider
// (else the one the remote names).
async function pullRequestProvider(args: {
  project: PullRequestProject;
  parentRepoPath: string;
}): Promise<{ remoteUrl: string | null; provider: Provider }> {
  const remoteUrl =
    args.project?.repoUrl ?? (await readRemoteOrigin(args.parentRepoPath));
  const provider = (args.project?.provider ??
    (remoteUrl ? detectProvider(remoteUrl) : "generic")) as Provider;

  return { remoteUrl, provider };
}

// Shared by the run git panel's Open PR and `pull_request` promotion. A
// provider that cannot open a PR — a `generic` remote, a missing CLI or token —
// is `provider_unsupported`, the same refusal on both paths.
export async function preflightedPrAdapter(args: {
  project: PullRequestProject;
  parentRepoPath: string;
}): Promise<PrAdapter> {
  const { remoteUrl, provider } = await pullRequestProvider(args);

  try {
    const adapter = selectPrAdapter(provider, { remoteUrl });

    await adapter.preflight();

    return adapter;
  } catch (err) {
    if (isMaisterError(err) && err.code === "PRECONDITION") {
      log.info(
        { provider, parentRepoPath: args.parentRepoPath, err: err.message },
        "pull request provider refused at preflight",
      );
      throw new MaisterError("PRECONDITION", err.message, {
        cause: err,
        details: { reason: "provider_unsupported" },
      });
    }

    throw err;
  }
}

export type RecordedPullRequest = {
  state: "open" | "merged" | "closed";
  // The commit the PR carries, which a merged PR keeps after its branch is gone.
  headSha: string;
};

// ADR-181 (Codex F4/F5) — the recorded PR as the provider reports it now. A
// finalize binds to its head, never to whatever was published last. No answer
// is ever read as a state: a read that retrying may fix is EXECUTOR_UNAVAILABLE,
// one it cannot (no PR support, an unparseable remote) `provider_unsupported`.
export async function readRecordedPullRequest(args: {
  project: PullRequestProject;
  parentRepoPath: string;
  prNumber: number;
}): Promise<RecordedPullRequest> {
  const { remoteUrl, provider } = await pullRequestProvider(args);
  const read =
    remoteUrl === null
      ? ({ kind: "unsupported" } as const)
      : await getPrState({ provider, remoteUrl, prNumber: args.prNumber });

  if (
    read.kind === "unsupported" ||
    (read.kind === "skip" && !read.transient)
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `pull request #${args.prNumber} cannot be read from provider ${provider}`,
      { details: { reason: "provider_unsupported" } },
    );
  }
  if (read.kind === "skip") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `pull request #${args.prNumber} could not be read: ${read.reason}`,
    );
  }
  if (read.headSha === null) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `provider ${provider} did not report the head of pull request #${args.prNumber}`,
    );
  }

  log.info(
    {
      provider,
      prNumber: args.prNumber,
      state: read.state,
      headSha: read.headSha,
    },
    "recorded pull request read",
  );

  return { state: read.state, headSha: read.headSha };
}

// A merged PR that does not carry the worktree's HEAD delivered less than the
// run holds: finalizing would declare the commits after it delivered.
export function mergedPullRequestBehind(args: {
  runId: string;
  prNumber: number;
  prHead: string;
  head: string;
}): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    `pull request #${args.prNumber} of run ${args.runId} was merged at ${args.prHead}, not at the worktree's HEAD ${args.head} — open a new pull request for the commits it lacks`,
    { details: { reason: "merged_pr_behind" } },
  );
}

// C35: the Open PR defaults — the panel pre-fills exactly what the server
// applies when the body omits them. The run link rides the request's origin
// (no public-URL setting exists for the web).
export function pullRequestDefaults(args: {
  run: { id: string; runKind: string };
  internalBranch: string;
  sourceBranch: string;
  targetBranch: string;
  // `<projects.task_key>-<tasks.number>`, null for a task-less run.
  taskKey: string | null;
  taskTitle: string | null;
  origin: string;
}): { title: string; body: string } {
  const runPath =
    args.run.runKind === "scratch"
      ? `/scratch-runs/${args.run.id}`
      : `/runs/${args.run.id}`;

  return {
    title:
      args.taskKey !== null && args.taskTitle !== null
        ? `${args.taskKey}: ${args.taskTitle}`
        : args.internalBranch,
    body: `${args.origin}${runPath}\n\nPublished ${args.sourceBranch} → ${args.targetBranch} (run ${args.run.id}).`,
  };
}
