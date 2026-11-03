import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchFlowPreparationIdentity } from "./launch-types";

import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import pino from "pino";

import {
  assertTaskLaunchCheckoutIdentity,
  assertTaskLaunchMaterializationReceipt,
} from "./launch-execution";
import { removeTaskLaunchFlowAssets } from "./launch-flow-assets";

import { projects, taskLaunchIntents } from "@/lib/db/schema";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { pgErrorOf } from "@/lib/db/pg-error";
import { worktreesRoot } from "@/lib/instance-config";
import { runtimeRoot } from "@/lib/runtime-root";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { assertSafeAgentMaterializationPath } from "@/lib/agents/materialization-manifest";
import { operationalCauseChain } from "@/lib/agents/operational-diagnostics";
import {
  acquireRepositoryMutationFence,
  commonGitDirectory,
} from "@/lib/project-config-persistence/repository-lock";
import { executeRepositoryGit } from "@/lib/project-config-persistence/git-process";
import {
  listWorktrees,
  localBranchHead,
  removeOwnedWorktree,
  statusPorcelain,
} from "@/lib/worktree";
import {
  assertWorktreeProvenancePristine,
  readWorktreeProvenanceMetadata,
} from "@/lib/worktree-provenance";

export type TaskLaunchPreparationCleanupOutcome =
  "none" | "busy" | "removed" | "retained";
export type TaskLaunchPreparationCleanupSummary = Readonly<{
  visited: number;
  none: number;
  busy: number;
  removed: number;
  retained: number;
}>;
type Intent = typeof taskLaunchIntents.$inferSelect;
type CleanupOwner = Readonly<{
  intent: Intent;
  identity: TaskLaunchFlowPreparationIdentity;
}>;
const CLOSED = ["held", "failed", "cancelled", "settled"] as const;
const log = pino({ name: "task-launch-preparation-cleanup" });

function unboundClosedPreparation(): SQL | undefined {
  return and(
    inArray(taskLaunchIntents.state, [...CLOSED]),
    isNull(taskLaunchIntents.runId),
    isNull(taskLaunchIntents.originalRunId),
    isNull(taskLaunchIntents.dispatchCommittedAt),
    sql`${taskLaunchIntents.preparationIdentity}->>'version'='1'`,
    sql`NOT EXISTS(SELECT 1 FROM runs linked WHERE linked.id=${taskLaunchIntents.preparationIdentity}->>'runId' OR linked.task_launch_intent_id=${taskLaunchIntents.id})`,
  );
}

function refuse(reason: string): never {
  throw new MaisterError(
    "PRECONDITION",
    "Launch preparation requires operator diagnosis before cleanup",
    { details: { reason } },
  );
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);

    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function currentOwner(
  db: Db,
  intentId: string,
): Promise<CleanupOwner | null> {
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(and(eq(taskLaunchIntents.id, intentId), unboundClosedPreparation()));

  return intent?.preparationIdentity?.version === 1
    ? { intent, identity: intent.preparationIdentity }
    : null;
}

async function stamp(
  db: Db,
  owner: CleanupOwner,
  state: "removed" | "retained",
): Promise<boolean> {
  const [written] = await db
    .update(taskLaunchIntents)
    .set({ cleanupState: state, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(taskLaunchIntents.id, owner.intent.id),
        unboundClosedPreparation(),
        eq(taskLaunchIntents.cleanupState, "pending"),
        sql`${taskLaunchIntents.preparationIdentity}->>'incarnationId'=${owner.identity.incarnationId}`,
      ),
    )
    .returning({ id: taskLaunchIntents.id });

  return written !== undefined;
}

async function assertCurrentCleanup(
  db: Db,
  owner: CleanupOwner,
): Promise<void> {
  const current = await currentOwner(db, owner.intent.id);

  if (
    !current ||
    current.intent.cleanupState !== "pending" ||
    current.identity.incarnationId !== owner.identity.incarnationId
  )
    throw new MaisterError(
      "CONFLICT",
      "Launch cleanup no longer owns this preparation",
      { details: { reason: "launch_cleanup_fenced" } },
    );
}

async function assertManagedPath(db: Db, owner: CleanupOwner): Promise<string> {
  const { identity, intent } = owner;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, intent.projectId));

  if (
    !project ||
    !/^[A-Za-z0-9_-]+$/.test(project.slug) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(identity.runId)
  )
    refuse("launch_cleanup_path_unknown");
  const root = path.resolve(worktreesRoot());
  const target = path.join(root, project.slug, identity.runId);

  if (
    path.resolve(identity.worktreePath) !== target ||
    identity.worktreePath !== target ||
    (await realpath(project.repoPath)) !== identity.parentRepoPath ||
    createHash("sha256")
      .update(`${identity.parentRepoPath}\0${identity.worktreePath}`)
      .digest("hex") !== identity.resourceId
  )
    refuse("launch_cleanup_identity_changed");
  let anchor = root;

  while (!(await present(anchor))) {
    const parent = path.dirname(anchor);

    if (parent === anchor) refuse("launch_cleanup_root_missing");
    anchor = parent;
  }
  await assertSafeAgentMaterializationPath(
    anchor,
    path.relative(anchor, target),
  );

  return project.slug;
}

async function git(repo: string, args: readonly string[]): Promise<string> {
  return (
    await executeRepositoryGit(repo, args, {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
    })
  ).stdout;
}

async function assertPristine(owner: CleanupOwner): Promise<void> {
  await assertWorktreeProvenancePristine(owner.identity.worktreePath);
  if (
    (
      await statusPorcelain({ worktreePath: owner.identity.worktreePath })
    ).trim()
  )
    refuse("launch_cleanup_dirty");
  const ignored = (
    await git(owner.identity.worktreePath, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ])
  )
    .split("\0")
    .filter(Boolean);

  if (ignored.some((file) => !file.startsWith(".maister-managed/")))
    refuse("launch_cleanup_ignored_bytes");
}

async function removePreparation(
  db: Db,
  owner: CleanupOwner,
  commonDirectory: string,
): Promise<void> {
  const { identity, intent } = owner;
  const slug = await assertManagedPath(db, owner);
  const exists = await present(identity.worktreePath);
  const worktrees = await listWorktrees(identity.parentRepoPath);
  const registered = worktrees.find(
    (tree) => tree.path === identity.worktreePath,
  );
  const branchHead = await localBranchHead({
    projectRepoPath: identity.parentRepoPath,
    branch: identity.branch,
  });

  if (exists) {
    await assertTaskLaunchCheckoutIdentity(intent);
    await assertSafeAgentMaterializationPath(identity.worktreePath, ".git");
    if ((await commonGitDirectory(identity.worktreePath)) !== commonDirectory)
      refuse("launch_cleanup_repository_changed");
    const provenance = await readWorktreeProvenanceMetadata(
      identity.worktreePath,
    );

    if (
      provenance.version !== 2 ||
      provenance.parentRepoPath !== identity.parentRepoPath ||
      provenance.branch !== identity.branch ||
      provenance.workspaceKind !== "flow"
    )
      refuse("launch_cleanup_provenance_changed");
    if (
      intent.preparationPhase === "materializing" ||
      intent.preparationPhase === "materialized"
    ) {
      const receiptDirectory = runDirPath(runtimeRoot(), slug, identity.runId);

      await assertSafeAgentMaterializationPath(
        runtimeRoot(),
        path.relative(
          runtimeRoot(),
          path.join(receiptDirectory, "launch-preparation.json"),
        ),
      );
      await assertTaskLaunchMaterializationReceipt(db, intent);
    } else if (
      intent.preparationPhase === "reserved" ||
      intent.preparationPhase === "checkout_ready"
    )
      await assertPristine(owner);
    else refuse("launch_cleanup_phase_unknown");
  } else {
    if (registered || (branchHead && intent.preparationPhase === "reserved"))
      refuse("launch_cleanup_ownership_unknown");
  }
  await assertCurrentCleanup(db, owner);
  await removeTaskLaunchFlowAssets(db, intent, identity);
  if (exists) {
    await removeOwnedWorktree({
      projectRepoPath: identity.parentRepoPath,
      worktreePath: identity.worktreePath,
      allowedRoot: worktreesRoot(),
      force: true,
    });
  }
  if (branchHead !== null) {
    if (
      branchHead !== identity.baseCommit ||
      (await listWorktrees(identity.parentRepoPath)).some(
        (tree) => tree.branch === `refs/heads/${identity.branch}`,
      )
    )
      refuse("launch_cleanup_branch_changed");
    await assertCurrentCleanup(db, owner);
    await git(identity.parentRepoPath, [
      "update-ref",
      "-d",
      `refs/heads/${identity.branch}`,
      identity.baseCommit,
    ]);
  }
  await assertCurrentCleanup(db, owner);
}

/** Pre-run resources have no workspace GC owner; their closed intent and physical repository fence own removal. */
export async function cleanupTaskLaunchPreparation(
  db: Db,
  intentId: string,
): Promise<TaskLaunchPreparationCleanupOutcome> {
  const initial = await currentOwner(db, intentId);

  if (!initial) return "none";
  if (initial.intent.cleanupState === "removed") return "removed";
  if (initial.intent.cleanupState === "retained") return "retained";
  const [armed] = await db
    .update(taskLaunchIntents)
    .set({ cleanupState: "pending", updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(taskLaunchIntents.id, intentId),
        unboundClosedPreparation(),
        or(
          isNull(taskLaunchIntents.cleanupState),
          eq(taskLaunchIntents.cleanupState, "pending"),
        ),
      ),
    )
    .returning();

  if (armed?.preparationIdentity?.version !== 1) return "none";
  const owner: CleanupOwner = {
    intent: armed,
    identity: armed.preparationIdentity,
  };
  let fence: Awaited<ReturnType<typeof acquireRepositoryMutationFence>> | null =
    null;

  try {
    await assertManagedPath(db, owner);
    const acquired = await acquireRepositoryMutationFence(
      owner.identity.parentRepoPath,
    );

    fence = acquired;
    await acquired.run(async () => {
      await assertCurrentCleanup(db, owner);
      await removePreparation(db, owner, acquired.commonDirectory);
      if (!(await stamp(db, owner, "removed")))
        throw new MaisterError(
          "CONFLICT",
          "Launch cleanup receipt was superseded",
          { details: { reason: "launch_cleanup_fenced" } },
        );
    });
    log.info(
      { intentId, resourceId: owner.identity.resourceId, outcome: "removed" },
      "task-launch-preparation-cleanup",
    );

    return "removed";
  } catch (error) {
    const reason = isMaisterError(error) ? error.details?.reason : undefined;

    if (reason === "operation_busy" || reason === "launch_cleanup_fenced") {
      log.info(
        { intentId, reason, outcome: "busy" },
        "task-launch-preparation-cleanup",
      );

      return "busy";
    }
    if (pgErrorOf(error)) throw error;
    if (!(await stamp(db, owner, "retained"))) return "busy";
    log.warn(
      {
        intentId,
        resourceId: owner.identity.resourceId,
        reason: reason ?? "launch_cleanup_uncertain",
        causeChain: operationalCauseChain(error),
        outcome: "retained",
      },
      "task-launch-preparation-cleanup",
    );

    return "retained";
  } finally {
    if (fence) {
      try {
        await fence.release();
      } catch (error) {
        fence.retain();
        throw error;
      }
    }
  }
}

/** Last-visit ordering advances past contended repositories without spending execution failure budget. */
export async function sweepTaskLaunchPreparationCleanup(
  db: Db,
  limit = 25,
): Promise<TaskLaunchPreparationCleanupSummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new MaisterError(
      "CONFIG",
      "Cleanup batch limit must be between 1 and 100",
    );
  const candidates = await db
    .select({ id: taskLaunchIntents.id })
    .from(taskLaunchIntents)
    .where(
      and(
        unboundClosedPreparation(),
        or(
          isNull(taskLaunchIntents.cleanupState),
          eq(taskLaunchIntents.cleanupState, "pending"),
        ),
      ),
    )
    .orderBy(asc(taskLaunchIntents.updatedAt), asc(taskLaunchIntents.id))
    .limit(limit);
  const outcomes: TaskLaunchPreparationCleanupOutcome[] = [];

  for (const candidate of candidates)
    outcomes.push(await cleanupTaskLaunchPreparation(db, candidate.id));

  return {
    visited: outcomes.length,
    none: outcomes.filter((value) => value === "none").length,
    busy: outcomes.filter((value) => value === "busy").length,
    removed: outcomes.filter((value) => value === "removed").length,
    retained: outcomes.filter((value) => value === "retained").length,
  };
}
