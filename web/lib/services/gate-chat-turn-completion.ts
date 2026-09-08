import "server-only";

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { applyWorkspacePolicy } from "@/lib/flows/graph/workspace-checkpoint";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { gateChatTurns, hitlRequests } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "gate-chat",
  level: process.env.LOG_LEVEL ?? "info",
});

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

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
        maxBuffer: 16 * 1024 * 1024,
        env: env ?? process.env,
      },
    );

    return stdout;
  } catch (err) {
    throw new MaisterError(
      "CHECKPOINT",
      `git ${args[0]} failed in ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

// Tree SHA of the CURRENT worktree content (tracked + untracked, ignored
// excluded) via a temp index — the L3 comparison probe. Same mechanism as
// captureCheckpoint, without writing a ref.
async function currentContentTree(worktreePath: string): Promise<string> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "maister-l3-probe-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: path.join(tmpDir, "index"),
  };

  try {
    await git(worktreePath, ["add", "-A"], env);

    return (await git(worktreePath, ["write-tree"], env)).trim();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function treePaths(
  worktreePath: string,
  tree: string,
): Promise<Set<string>> {
  const out = await git(worktreePath, ["ls-tree", "-r", "--name-only", tree]);

  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

// M30 (ADR-078 L3): the hard neutrality guarantee. Compares the current
// worktree content (tree probe + branch tip) against the first-turn
// baseline; on a delta restores the baseline (ADR-079 rewind overlay) and
// deletes ONLY the rogue untracked paths absent from the baseline tree —
// never a blanket clean, never `.maister/`. Fail-closed: a sensor that
// cannot sense throws CHECKPOINT.
export async function senseAndRestore(args: {
  worktreePath: string;
  baselineRef: string;
}): Promise<{ reverted: boolean }> {
  const baselineSha = (
    await git(args.worktreePath, [
      "rev-parse",
      "--verify",
      `${args.baselineRef}^{commit}`,
    ])
  ).trim();
  const baselineTree = (
    await git(args.worktreePath, ["rev-parse", `${baselineSha}^{tree}`])
  ).trim();
  const baselineTip = (
    await git(args.worktreePath, ["rev-parse", `${baselineSha}^`])
  ).trim();

  const currentTip = (
    await git(args.worktreePath, ["rev-parse", "HEAD"])
  ).trim();
  const currentTree = await currentContentTree(args.worktreePath);

  if (currentTree === baselineTree && currentTip === baselineTip) {
    return { reverted: false };
  }

  // Rogue untracked paths: present in the current content, absent from the
  // baseline tree. Computed BEFORE the restore (the rewind overlay leaves
  // attempt-created untracked files in place by design — DD6).
  const currentPaths = await treePaths(args.worktreePath, currentTree);
  const baselinePaths = await treePaths(args.worktreePath, baselineSha);
  const rogue = [...currentPaths].filter((p) => !baselinePaths.has(p));

  await applyWorkspacePolicy({
    policy: "rewind-to-node-checkpoint",
    worktreePath: args.worktreePath,
    checkpointRef: args.baselineRef,
  });

  for (const rel of rogue) {
    const abs = path.resolve(args.worktreePath, rel);

    // Path containment: the restore never reaches outside the worktree.
    if (!abs.startsWith(path.resolve(args.worktreePath) + path.sep)) continue;
    await rm(abs, { force: true });
  }

  log.warn(
    { worktreePath: args.worktreePath, rogueCount: rogue.length },
    "[neutrality] reverted mutation",
  );

  return { reverted: true };
}

/** DB-only terminalization of a still-pending turn. The response path locks the
 * HITL row first; this keeps that order so a concurrent claim cannot deadlock. */
export async function terminalizePendingGateChatTurn(
  tx: Db,
  args: {
    turnId: string;
    hitlRequestId: string;
    errorCode: string;
    terminalState?: "failed" | "aborted";
  },
): Promise<boolean> {
  const hitlRows = await tx
    .select({
      response: hitlRequests.response,
      respondedAt: hitlRequests.respondedAt,
    })
    .from(hitlRequests)
    .where(eq(hitlRequests.id, args.hitlRequestId))
    .for("update");
  const hitl = hitlRows[0];
  const turnRows = await tx
    .select({ id: gateChatTurns.id, state: gateChatTurns.state })
    .from(gateChatTurns)
    .where(eq(gateChatTurns.id, args.turnId))
    .for("update");
  const turn = turnRows[0];

  if (!turn || turn.state !== "pending") return false;

  const isClaimed =
    !hitl || hitl.response !== null || hitl.respondedAt !== null;

  await tx
    .update(gateChatTurns)
    .set({
      state: args.terminalState ?? (isClaimed ? "aborted" : "failed"),
      leaseExpiresAt: null,
      completedAt: new Date(),
      errorCode: args.errorCode,
    })
    .where(eq(gateChatTurns.id, args.turnId));

  return true;
}

export async function failGateChatTurn(args: {
  db: Db;
  turnId: string;
  hitlRequestId: string;
  errorCode: string;
  terminalState?: "failed" | "aborted";
}): Promise<void> {
  await args.db.transaction(async (tx: Db) => {
    await terminalizePendingGateChatTurn(tx, args);
  });
}
