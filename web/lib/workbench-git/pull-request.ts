import "server-only";

import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { selectPrAdapter, type PrAdapter } from "@/lib/runs/pr-adapter";
import {
  detectProvider,
  readRemoteOrigin,
  type Provider,
} from "@/lib/repo-source";

const log = pino({
  name: "workbench-git-pr",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-181 D11 — the ONE provider resolution for a pull request, shared by the
// run git panel's Open PR and `pull_request` promotion: the project's recorded
// remote (else the parent checkout's origin), its recorded provider (else the
// one the remote names), preflighted. A provider that cannot open a PR — a
// `generic` remote, a missing CLI or token — is `provider_unsupported`, the
// same refusal on both paths.
export async function preflightedPrAdapter(args: {
  project: { repoUrl?: string | null; provider?: string | null } | null;
  parentRepoPath: string;
}): Promise<PrAdapter> {
  const remoteUrl =
    args.project?.repoUrl ?? (await readRemoteOrigin(args.parentRepoPath));
  const provider = (args.project?.provider ??
    (remoteUrl ? detectProvider(remoteUrl) : "generic")) as Provider;

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
