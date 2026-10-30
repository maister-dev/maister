import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { OperationalCleanup } from "@/lib/run-results/operational-types";
import type { PreserveWorktreeArgs, PreserveResult } from "@/lib/gc/preserve";

import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import pino from "pino";

import {
  inspectOperationalRun,
  operationalWorkspace,
} from "@/lib/agents/operational-context";
import { restoreAgentMaterialization } from "@/lib/agents/dirty-watchdog";
import { operationalAgentRuntimePath } from "@/lib/agents/workspace-paths";
import { frozenOperationalDefinition } from "@/lib/agents/launch-contract";
import {
  checkContextMountDirt,
  releaseRunContextMounts,
} from "@/lib/context-mounts/terminal";
import { getDb } from "@/lib/db/client";
import {
  executionAssignments,
  executionCommands,
  hitlRequests,
  operationalCleanupProgress,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { getLatestAssignment } from "@/lib/execution-host/assignments";
import { TERMINAL_COMMAND_STATES } from "@/lib/execution-host/types";
import { preserveOperationalEvidence } from "@/lib/gc/operational-evidence";
import { removeOwnedPlainAgentDirectory } from "@/lib/gc/plain-agent-directory-gc";
import { preserveWorktree } from "@/lib/gc/preserve";
import { worktreesRoot } from "@/lib/instance-config";
import {
  claimLifecycleOperation,
  finalizeLifecycleOperation,
  recordArchive,
  renewLifecycleOperationLease,
} from "@/lib/workbench-lifecycle/service";
import { removeOwnedWorktree } from "@/lib/worktree";

const log = pino({ name: "operational-disposition" });
const DELAYS = [60_000, 300_000, 1_800_000, 7_200_000] as const;
const TERMINAL = ["Done", "Failed", "Crashed", "Abandoned"] as const;
const LEASE_MS = 300_000;

export type OperationalDispositionOptions = {
  db?: Db;
  hosts?: ExecutionHosts;
  now?: Date;
  preserve?: (args: PreserveWorktreeArgs) => Promise<PreserveResult>;
};

async function exists(cwd: string): Promise<boolean> {
  try {
    await lstat(cwd);

    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

function cleanupError(reason: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "operational cleanup requires diagnosis before disposal",
    { details: { reason } },
  );
}

/** Existing terminal/GC owners share this disposition; no new scheduler job. */
export async function disposeOperationalRun(
  runId: string,
  options: OperationalDispositionOptions = {},
): Promise<"skipped" | "released" | "deferred"> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));

  if (
    run?.agentKind !== "operational" ||
    !run.operationalTerminal ||
    !run.operationalCleanup ||
    !TERMINAL.includes(run.status as (typeof TERMINAL)[number])
  )
    return "skipped";
  const initial = run.operationalCleanup;

  if (
    initial.state === "released" ||
    initial.state === "exhausted" ||
    !initial.dueAt ||
    Date.parse(initial.dueAt) > now.getTime()
  )
    return "skipped";
  if (initial.lease && Date.parse(initial.lease.expiresAt) > Date.now())
    return "skipped";
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, runId));

  if (initial.resourceKind === "worktree" && !workspace) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(runs)
        .set({
          operationalCleanup: {
            ...initial,
            state: "exhausted",
            revision: initial.revision + 1,
            dueAt: null,
            errorCode: "operational_workspace_ownership_missing",
            lease: null,
          },
        })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, run.status),
            sql`${runs.operationalCleanup}->>'revision' = ${String(initial.revision)}`,
          ),
        )
        .returning({ id: runs.id });

      if (updated.length)
        await emitDomainEvent({
          db: tx,
          kind: "run.operational_cleanup_changed",
          projectId: run.projectId!,
          taskId: run.taskId,
          runId,
          payload: {
            runId,
            revision: initial.revision + 1,
            state: "exhausted",
          },
        });
    });
    log.error({ runId }, "operational-workspace-ownership-missing");

    return "deferred";
  }
  let attemptId: string | null = null;
  let cleanup = initial;
  let claimed = false;
  const rowlessId = randomUUID();
  const hosts = options.hosts ?? createExecutionHosts({ db });

  const persist = async (next: OperationalCleanup): Promise<void> => {
    await db.transaction(async (tx) => {
      if (workspace) {
        const [fence] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.id, workspace.id),
              eq(workspaces.lifecycleOperationAttemptId, attemptId!),
              eq(workspaces.lifecycleOperationState, "claiming"),
              gt(workspaces.lifecycleOperationLeaseExpiresAt, new Date()),
            ),
          )
          .for("update");

        if (!fence) throw cleanupError("operational_cleanup_fenced");
      }
      const [updated] = await tx
        .update(runs)
        .set({ operationalCleanup: next })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, run.status),
            sql`${runs.operationalCleanup}->>'revision' = ${String(cleanup.revision)}`,
            ...(workspace
              ? []
              : [
                  sql`${runs.operationalCleanup}->'lease'->>'id' = ${rowlessId}`,
                  sql`(${runs.operationalCleanup}->'lease'->>'expiresAt')::timestamptz > now()`,
                ]),
          ),
        )
        .returning({ id: runs.id });

      if (!updated) throw cleanupError("operational_cleanup_fenced");
      if (
        next.revision !== cleanup.revision ||
        next.state !== cleanup.state ||
        next.errorCode !== cleanup.errorCode
      )
        await emitDomainEvent({
          db: tx,
          kind: "run.operational_cleanup_changed",
          projectId: run.projectId!,
          taskId: run.taskId,
          runId,
          payload: { runId, revision: next.revision, state: next.state },
        });
      if (workspace)
        await tx
          .update(workspaces)
          .set({ scheduledRemovalAt: next.dueAt ? new Date(next.dueAt) : null })
          .where(eq(workspaces.id, workspace.id));
    });
    cleanup = next;
  };
  const renew = async (): Promise<void> => {
    if (workspace)
      await renewLifecycleOperationLease({
        database: db,
        workspaceId: workspace.id,
        attemptId: attemptId!,
      });
    else
      await persist({
        ...cleanup,
        lease: {
          id: rowlessId,
          owner: "operational-disposition",
          expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
        },
      });
  };

  try {
    if (workspace) {
      attemptId = (
        await claimLifecycleOperation({
          database: db,
          workspaceId: workspace.id,
          runId,
          operation: "retention_gc",
          expectedRunStatus: run.status,
        })
      ).attemptId;
      const [fresh] = await db
        .select({ cleanup: runs.operationalCleanup })
        .from(runs)
        .where(eq(runs.id, runId));

      if (!fresh?.cleanup || fresh.cleanup.revision !== initial.revision)
        throw cleanupError("operational_cleanup_fenced");
    } else {
      const next = {
        ...initial,
        lease: {
          id: rowlessId,
          owner: "operational-disposition",
          expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
        },
      };
      const [updated] = await db
        .update(runs)
        .set({ operationalCleanup: next })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, run.status),
            sql`${runs.operationalCleanup}->>'revision' = ${String(initial.revision)}`,
            sql`(${runs.operationalCleanup}->'lease' = 'null'::jsonb OR (${runs.operationalCleanup}->'lease'->>'expiresAt')::timestamptz <= now())`,
          ),
        )
        .returning({ id: runs.id });

      if (!updated) return "skipped";
      cleanup = next;
    }
    claimed = true;
    await persist({
      ...cleanup,
      state: cleanup.removedAt ? "removed" : "preserving",
      attempts: cleanup.attempts + 1,
      revision: cleanup.revision + 1,
      errorCode: null,
    });
    frozenOperationalDefinition(run);
    const [active] = await db
      .select({ id: executionAssignments.id })
      .from(executionAssignments)
      .where(
        and(
          eq(executionAssignments.runId, runId),
          eq(executionAssignments.state, "active"),
        ),
      )
      .limit(1);
    const [openCommand] = await db
      .select({ id: executionCommands.id })
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          notInArray(executionCommands.state, [...TERMINAL_COMMAND_STATES]),
        ),
      )
      .limit(1);
    const [openHitl] = await db
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, runId),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.supersededAt),
        ),
      )
      .limit(1);

    if (active || openCommand || openHitl)
      throw cleanupError("operational_execution_not_quiescent");
    const assignment = await getLatestAssignment(db, runId);
    const client = assignment ? await hosts.forAssignment(assignment) : null;

    if (
      client &&
      (await client.sessionsForRun()).some(
        (session) => session.status === "live",
      )
    )
      throw cleanupError("operational_execution_not_quiescent");
    const context = await operationalWorkspace(db, run);
    const present = await exists(context.cwd);

    for (const mount of run.contextMounts ?? []) {
      const verdict = await checkContextMountDirt(mount.mountPath);

      if (verdict.kind === "dirty" || verdict.kind === "indeterminate") {
        if (!client) throw cleanupError("operational_evidence_host_missing");
        const ids = await preserveOperationalEvidence({
          runId,
          cwd: mount.mountPath,
          resourceKind: "ephemeral_checkout",
          client,
          renew,
        });

        await persist({
          ...cleanup,
          evidenceIds: [...new Set([...cleanup.evidenceIds, ...ids])],
        });
      }
    }
    await renew();
    const mounts = await releaseRunContextMounts({ runId, db });

    if (mounts.skippedLive)
      throw cleanupError("operational_context_cleanup_failed");
    if (!cleanup.removedAt && present) {
      const integrity = await inspectOperationalRun(db, run);
      const preserveBytes =
        run.status !== "Done" || integrity.verdict !== "clean";

      if (preserveBytes) {
        if (!client) throw cleanupError("operational_evidence_host_missing");
        const evidenceIds = await preserveOperationalEvidence({
          runId,
          cwd: context.cwd,
          resourceKind: context.resourceKind,
          client,
          renew,
        });

        await persist({
          ...cleanup,
          evidenceIds: [...new Set([...cleanup.evidenceIds, ...evidenceIds])],
        });
      }
      await renew();
      await restoreAgentMaterialization(context.cwd, runId);
      if (workspace) {
        const preserved = await (options.preserve ?? preserveWorktree)({
          runId,
          worktreePath: context.cwd,
          parentRepoPath: context.repoPath,
          branch: workspace.branch,
          baseRef: workspace.baseCommit ?? workspace.baseBranch ?? "HEAD",
          archivePush: false,
        });

        if (!preserved.ok)
          throw cleanupError(
            preserved.failureReason ?? "operational_preservation_failed",
          );
        await recordArchive({
          database: db,
          workspaceId: workspace.id,
          attemptId: attemptId!,
          archivedBranch: preserved.archivedBranch ?? null,
          archivedAt: preserved.archivedAt ?? new Date(),
          archivedCommit: preserved.archivedCommit ?? null,
          preservationOutcome: preserved.preservationOutcome ?? "not_needed",
        });
      }
      await renew();
      if (
        context.resourceKind === "worktree" ||
        context.resourceKind === "ephemeral_checkout"
      )
        await removeOwnedWorktree({
          projectRepoPath: context.repoPath,
          worktreePath: context.cwd,
          allowedRoot: worktreesRoot(),
          force: true,
        });
      else if (context.resourceKind === "plain_directory")
        await removeOwnedPlainAgentDirectory({
          root: worktreesRoot(),
          directoryPath: context.cwd,
        });
      // Shared parent repositories are never removed. Only this run's leases release.
    }
    const removedAt = cleanup.removedAt ?? new Date().toISOString();

    if (workspace) {
      const [recorded] = await db
        .update(workspaces)
        .set({ removedAt: new Date(removedAt), removalKind: "retention_gc" })
        .where(
          and(
            eq(workspaces.id, workspace.id),
            eq(workspaces.lifecycleOperationAttemptId, attemptId!),
            eq(workspaces.lifecycleOperationState, "claiming"),
            gt(workspaces.lifecycleOperationLeaseExpiresAt, new Date()),
          ),
        )
        .returning({ id: workspaces.id });

      if (!recorded) throw cleanupError("operational_cleanup_fenced");
    }
    await persist({ ...cleanup, state: "removed", removedAt });
    await renew();
    await removeOwnedPlainAgentDirectory({
      root: worktreesRoot(),
      directoryPath: operationalAgentRuntimePath(context.projectSlug, runId),
    });
    if (client && assignment?.executionWorkspaceId)
      await client.releaseWorkspace(assignment.executionWorkspaceId);
    await persist({
      ...cleanup,
      state: "released",
      releasedAt: new Date().toISOString(),
      dueAt: null,
      errorCode: null,
      lease: null,
    });
    if (workspace)
      await finalizeLifecycleOperation({
        database: db,
        workspaceId: workspace.id,
        attemptId: attemptId!,
        state: "done",
      });
    log.info(
      {
        runId,
        revision: cleanup.revision,
        evidenceCount: cleanup.evidenceIds.length,
      },
      "operational-workspace-released",
    );

    return "released";
  } catch (error) {
    if (!claimed) {
      if (workspace && attemptId)
        await finalizeLifecycleOperation({
          database: db,
          workspaceId: workspace.id,
          attemptId,
          state: "failed",
        });

      return "skipped";
    }
    const reason =
      isMaisterError(error) && typeof error.details?.reason === "string"
        ? error.details.reason
        : "operational_cleanup_failed";
    const exhausted = cleanup.attempts >= 5;

    try {
      await persist({
        ...cleanup,
        state: exhausted ? "exhausted" : "retry",
        dueAt: exhausted
          ? null
          : new Date(
              now.getTime() + DELAYS[cleanup.attempts - 1],
            ).toISOString(),
        errorCode: reason,
        revision: cleanup.revision + 1,
        lease: null,
      });
      if (workspace)
        await finalizeLifecycleOperation({
          database: db,
          workspaceId: workspace.id,
          attemptId: attemptId!,
          state: "failed",
        });
    } catch (fenceError) {
      log.warn(
        {
          runId,
          errorType: fenceError instanceof Error ? fenceError.name : "unknown",
        },
        "operational-cleanup-stale-owner-yielded",
      );
    }
    log.error(
      { runId, reason, attempts: cleanup.attempts, exhausted },
      "operational-cleanup-deferred",
    );

    return "deferred";
  }
}

/** A durable keyset cursor rotates past failed and held eligible rows. */
export async function sweepOperationalDispositions(
  options: OperationalDispositionOptions = {},
): Promise<{ scanned: number; released: number; deferred: number }> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  await db
    .insert(operationalCleanupProgress)
    .values({ id: "default" })
    .onConflictDoNothing();
  const [progress] = await db
    .select()
    .from(operationalCleanupProgress)
    .where(eq(operationalCleanupProgress.id, "default"));
  const candidates = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.agentKind, "operational"),
        inArray(runs.status, [...TERMINAL]),
        sql`${runs.operationalCleanup}->>'state' IN ('armed','retained','retry','removed','preserving')`,
        sql`(${runs.operationalCleanup}->>'dueAt')::timestamptz <= ${now}`,
        progress.cursorId ? gt(runs.id, progress.cursorId) : sql`true`,
      ),
    )
    .orderBy(asc(runs.id))
    .limit(100);
  let released = 0;
  let deferred = 0;

  for (const candidate of candidates) {
    try {
      const result = await disposeOperationalRun(candidate.id, {
        ...options,
        db,
        now,
      });

      if (result === "released") released += 1;
      if (result === "deferred") deferred += 1;
    } finally {
      await db
        .update(operationalCleanupProgress)
        .set({ cursorId: candidate.id, updatedAt: now })
        .where(eq(operationalCleanupProgress.id, "default"));
    }
  }
  if (!candidates.length)
    await db
      .update(operationalCleanupProgress)
      .set({ cursorId: null, updatedAt: now })
      .where(eq(operationalCleanupProgress.id, "default"));

  return { scanned: candidates.length, released, deferred };
}
