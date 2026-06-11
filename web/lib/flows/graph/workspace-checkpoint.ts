import "server-only";

import type { WorkspacePolicy } from "@/lib/config.schema";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import pino from "pino";

import { MaisterError } from "@/lib/errors";
import { runtimeRoot } from "@/lib/instance-config";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "workspace-checkpoint",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

// ADR-076: dangling checkpoint refs live OUTSIDE refs/heads — never on the
// run branch. `checkpoints` holds per-node-attempt pre-attempt state;
// `chat-checkpoints` holds the ADR-075 L3 gate-chat baseline (bounded at 1
// per hitlRequest).
export type CheckpointNamespace = "checkpoints" | "chat-checkpoints";

const REF_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Deterministic git identity for checkpoint commit objects: capture must not
// depend on host-level git identity config (consumer repos / fresh hosts).
const CHECKPOINT_GIT_IDENT_ENV = {
  GIT_AUTHOR_NAME: "maister-checkpoint",
  GIT_AUTHOR_EMAIL: "checkpoint@maister.local",
  GIT_COMMITTER_NAME: "maister-checkpoint",
  GIT_COMMITTER_EMAIL: "checkpoint@maister.local",
} as const;

async function git(
  worktreePath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        env: env ?? process.env,
      },
    );

    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.error(
      { worktreePath, args: args.slice(0, 3), err: message },
      "[checkpoint] git failed",
    );
    throw new MaisterError(
      "CHECKPOINT",
      `git ${args[0]} failed in ${worktreePath}: ${message}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

function assertRefSegment(value: string, label: string): void {
  if (!REF_SEGMENT.test(value)) {
    throw new MaisterError(
      "CHECKPOINT",
      `invalid ${label} for checkpoint ref: ${JSON.stringify(value)}`,
    );
  }
}

export function checkpointRefName(
  namespace: CheckpointNamespace,
  runId: string,
  id: string,
): string {
  assertRefSegment(runId, "runId");
  assertRefSegment(id, "id");

  return `refs/maister/${namespace}/${runId}/${id}`;
}

// DD10 / ADR-076 §5: hard-block any workspace mutation when the runtime
// artifacts root resolves INSIDE the worktree — `git clean -fd` could reach a
// non-ignored artifacts path. Operational precondition → PRECONDITION.
export function containmentAssert(
  worktreePath: string,
  runtimeRootOverride?: string,
): void {
  const root = path.resolve(runtimeRootOverride ?? runtimeRoot());
  const wt = path.resolve(worktreePath);
  const rel = path.relative(wt, root);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));

  if (inside) {
    throw new MaisterError(
      "PRECONDITION",
      `MAISTER_RUNTIME_ROOT resolves inside the worktree (${root} within ${wt}) — ` +
        `run artifacts could be reached by workspace mutations; fix the deployment layout`,
    );
  }
}

// ADR-076 §1: capture HEAD + tracked + untracked (ignored EXCLUDED) as a
// temp-index commit PARENTED ON THE CURRENT TIP, stored as a dangling
// namespaced ref. The branch is never advanced; `<ck>^` is the pre-attempt
// tip for free.
export async function captureCheckpoint(args: {
  worktreePath: string;
  namespace: CheckpointNamespace;
  runId: string;
  id: string;
}): Promise<{ ref: string; sha: string }> {
  const ref = checkpointRefName(args.namespace, args.runId, args.id);
  const tip = (await git(args.worktreePath, ["rev-parse", "HEAD"])).trim();
  const tmpDir = await mkdtemp(path.join(tmpdir(), "maister-ck-index-"));
  const indexFile = path.join(tmpDir, "index");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...CHECKPOINT_GIT_IDENT_ENV,
    GIT_INDEX_FILE: indexFile,
  };

  try {
    // Empty temp index + `add -A` stages the exact working-tree content
    // (tracked + untracked, .gitignore respected) without touching the real
    // index.
    await git(args.worktreePath, ["add", "-A"], env);
    const tree = (await git(args.worktreePath, ["write-tree"], env)).trim();
    const sha = (
      await git(
        args.worktreePath,
        [
          "commit-tree",
          tree,
          "-p",
          tip,
          "-m",
          `maister checkpoint ${args.namespace}/${args.runId}/${args.id}`,
        ],
        env,
      )
    ).trim();

    await git(args.worktreePath, ["update-ref", ref, sha]);

    log.debug(
      { worktreePath: args.worktreePath, ref, sha, tip },
      "[checkpoint] capture",
    );

    return { ref, sha };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ADR-076 §2: policy semantics against a captured checkpoint.
// - keep: strict no-op.
// - rewind-to-node-checkpoint: branch back to `<ck>^`, working tree restored
//   to the captured state UNSTAGED. NEVER `reset --hard <ck>` (grafts the
//   temp-index commit onto the branch and tracks captured-untracked files).
// - fresh-attempt: `reset --hard <ck>^` + `git clean -fd` (`-fd`, never
//   `-fdx` — ignored build caches and an ignored .maister/ survive), then
//   the re-materialization hook (ADR-076 §4).
export async function applyWorkspacePolicy(args: {
  policy: WorkspacePolicy;
  worktreePath: string;
  checkpointRef: string;
  rematerialize?: () => Promise<unknown>;
}): Promise<void> {
  containmentAssert(args.worktreePath);

  if (args.policy === "keep") {
    log.debug(
      { worktreePath: args.worktreePath, policy: "keep" },
      "[checkpoint] apply policy=keep (no-op)",
    );

    return;
  }

  const ck = (
    await git(args.worktreePath, [
      "rev-parse",
      "--verify",
      `${args.checkpointRef}^{commit}`,
    ])
  ).trim();
  const preAttemptTip = (
    await git(args.worktreePath, ["rev-parse", `${ck}^`])
  ).trim();

  if (args.policy === "rewind-to-node-checkpoint") {
    await git(args.worktreePath, ["reset", "--hard", preAttemptTip]);
    // Overlay the captured tree into index + working tree, then mixed-reset
    // the index back to the pre-attempt tip: captured-tracked deltas become
    // unstaged modifications, captured-untracked files return UNTRACKED, and
    // attempt-created untracked files (absent from both trees) survive.
    await git(args.worktreePath, [
      "read-tree",
      "--reset",
      "-u",
      `${ck}^{tree}`,
    ]);
    await git(args.worktreePath, ["reset", "--mixed", preAttemptTip]);
  } else {
    await git(args.worktreePath, ["reset", "--hard", preAttemptTip]);
    await git(args.worktreePath, ["clean", "-fd"]);

    if (args.rematerialize) {
      await args.rematerialize();
      log.debug(
        { worktreePath: args.worktreePath },
        "[checkpoint] re-materialized capability bundles after fresh-attempt",
      );
    }
  }

  log.info(
    {
      worktreePath: args.worktreePath,
      policy: args.policy,
      checkpointRef: args.checkpointRef,
      preAttemptTip,
    },
    "[checkpoint] apply policy",
  );
}

// ADR-076 GC: delete every checkpoint ref a run accumulated. Refs are
// repo-global (shared common git dir), so worktree removal alone never
// cleans them — the workspace GC calls this against the PARENT repo, and the
// runner calls the chat-only variant when a HITL pause resolves. Returns the
// number of refs removed.
export async function deleteRunCheckpointRefs(
  repoPath: string,
  runId: string,
  namespaces: CheckpointNamespace[] = ["checkpoints", "chat-checkpoints"],
): Promise<number> {
  assertRefSegment(runId, "runId");

  let removed = 0;

  for (const ns of namespaces) {
    const out = await git(repoPath, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/maister/${ns}/${runId}`,
    ]);

    for (const ref of out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      await git(repoPath, ["update-ref", "-d", ref]);
      removed += 1;
    }
  }

  if (removed > 0) {
    log.info({ repoPath, runId, removed }, "[checkpoint] GC removed refs");
  }

  return removed;
}

// ADR-075 (DD11/DD12): drop the gate-chat L3 baseline ref so the sensor
// re-anchors on the next turn. Idempotent — a missing ref is fine (already
// GC'd / never captured / invalidated twice).
export async function deleteChatCheckpoint(
  worktreePath: string,
  runId: string,
  hitlRequestId: string,
): Promise<void> {
  const ref = checkpointRefName("chat-checkpoints", runId, hitlRequestId);

  try {
    await execFileAsync("git", ["-C", worktreePath, "update-ref", "-d", ref], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    log.debug({ worktreePath, ref }, "[checkpoint] chat baseline deleted");
  } catch {
    log.debug(
      { worktreePath, ref },
      "[checkpoint] chat baseline delete skipped (ref missing)",
    );
  }
}
