import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ScheduledLaunchReservation } from "@/lib/scheduled-launches/types";
import type * as schema from "@/lib/db/schema";

import path from "node:path";

import { and, eq, lte, or, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  runs,
  scheduledTaskLaunchAttempts,
  scheduledTaskLaunchEvents,
  scheduledTaskLaunches,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { worktreesRoot } from "@/lib/instance-config";
import {
  claimScheduledLaunch,
  dispatchClaimedScheduledLaunch,
  SCHEDULED_LAUNCH_CLAIM_LEASE_MS,
} from "@/lib/scheduled-launches/service";
import {
  listWorktrees,
  localBranchHead,
  removeBranch,
  removeOwnedWorktree,
  statusPorcelain,
} from "@/lib/worktree";
import { readWorktreeProvenanceMetadata } from "@/lib/worktree-provenance";

const log = pino({
  name: "scheduled-launch-dispatcher",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_BATCH_SIZE = 25;

type ScheduledLaunchDb = NodePgDatabase<typeof schema>;

type DueScheduledLaunch = {
  id: string;
  projectId: string;
};

type StaleDispatch = {
  claimFence: number;
  claimId: string;
  launchRequest: { baseCommit?: string };
  projectId: string;
  projectRepoPath: string;
  projectSlug: string;
  reservation: ScheduledLaunchReservation;
  scheduledForAt: Date;
  scheduledLaunchId: string;
};

type DispatchSummary = {
  claimed: number;
  failed: number;
  late: number;
  launched: number;
  recovered: number;
  retried: number;
  scanned: number;
  truncated: boolean;
};

function initialSummary(): DispatchSummary {
  return {
    claimed: 0,
    failed: 0,
    late: 0,
    launched: 0,
    recovered: 0,
    retried: 0,
    scanned: 0,
    truncated: false,
  };
}

function isExpectedClaimContention(error: unknown): boolean {
  return error instanceof MaisterError && error.code === "CONFLICT";
}

async function listDueScheduledLaunches(input: {
  db: ScheduledLaunchDb;
  now: Date;
  limit: number;
}): Promise<{ rows: DueScheduledLaunch[]; truncated: boolean }> {
  const rows = await input.db
    .select({
      id: scheduledTaskLaunches.id,
      projectId: scheduledTaskLaunches.projectId,
    })
    .from(scheduledTaskLaunches)
    .where(
      and(
        or(
          eq(scheduledTaskLaunches.state, "Scheduled"),
          eq(scheduledTaskLaunches.state, "RetryWaiting"),
        ),
        lte(scheduledTaskLaunches.nextAttemptAt, input.now),
      ),
    )
    .orderBy(scheduledTaskLaunches.nextAttemptAt, scheduledTaskLaunches.id)
    .limit(input.limit + 1);

  return {
    rows: rows.slice(0, input.limit),
    truncated: rows.length > input.limit,
  };
}

async function reclaimOneStaleDispatch(input: {
  db: ScheduledLaunchDb;
  now: Date;
}): Promise<StaleDispatch | null> {
  const claimId = crypto.randomUUID();

  return input.db.transaction(async (tx) => {
    const claimed = await tx.execute<{
      claimFence: number;
      claimId: string;
      id: string;
      launchRequest: { baseCommit?: string };
      projectId: string;
      projectRepoPath: string;
      projectSlug: string;
      scheduledForAt: Date | string;
    }>(sql`
      SELECT
        l.id,
        l.project_id AS "projectId",
        l.claim_id AS "claimId",
        l.claim_fence AS "claimFence",
        l.launch_request AS "launchRequest",
        l.scheduled_for_at AS "scheduledForAt",
        p.repo_path AS "projectRepoPath",
        p.slug AS "projectSlug"
      FROM scheduled_task_launches l
      INNER JOIN projects p ON p.id = l.project_id
      WHERE l.state = 'Dispatching'
        AND l.claim_expires_at <= ${input.now}
      ORDER BY l.claim_expires_at, l.id
      FOR UPDATE OF l SKIP LOCKED
      LIMIT 1
    `);
    const row = claimed.rows[0];

    if (!row) return null;

    const scheduledForAt =
      row.scheduledForAt instanceof Date
        ? row.scheduledForAt
        : new Date(row.scheduledForAt);

    if (Number.isNaN(scheduledForAt.getTime())) {
      throw new MaisterError(
        "PRECONDITION",
        "scheduled launch contains an invalid timestamp",
      );
    }

    const linkedRuns = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.scheduledLaunchId, row.id));
    const linkedRunId = linkedRuns[0]?.id;

    const reservations = await tx
      .select()
      .from(scheduledTaskLaunchAttempts)
      .where(eq(scheduledTaskLaunchAttempts.scheduledLaunchId, row.id));
    const storedReservation = reservations[0];

    if (linkedRunId) {
      await tx
        .update(scheduledTaskLaunches)
        .set({
          state: "Launched",
          nextAttemptAt: null,
          claimId: null,
          claimFence: null,
          claimExpiresAt: null,
          claimOrigin: null,
          latestOutcome: "launched",
          errorCode: null,
          errorMessage: null,
          lateByMs: Math.max(0, input.now.getTime() - scheduledForAt.getTime()),
          updatedAt: input.now,
        })
        .where(eq(scheduledTaskLaunches.id, row.id));
      if (storedReservation) {
        await tx
          .update(scheduledTaskLaunchAttempts)
          .set({ state: "RunLinked", updatedAt: input.now })
          .where(eq(scheduledTaskLaunchAttempts.id, storedReservation.id));
      }
      await tx.insert(scheduledTaskLaunchEvents).values({
        id: crypto.randomUUID(),
        scheduledLaunchId: row.id,
        kind: "launched",
        actorType: "system",
        claimFence: row.claimFence,
        metadata: { runId: linkedRunId, recovery: "existing_run" },
        createdAt: input.now,
      });

      return null;
    }

    if (!storedReservation || row.claimId === null || row.claimFence === null) {
      await terminalizeStaleDispatch(tx, {
        scheduledLaunchId: row.id,
        claimFence: row.claimFence,
        errorCode: "PRECONDITION",
        message: "Scheduled launch recovery could not verify its reservation",
        now: input.now,
      });

      return null;
    }

    const claimFence = row.claimFence + 1;

    await tx
      .update(scheduledTaskLaunchAttempts)
      .set({ state: "Reserved", claimFence, updatedAt: input.now })
      .where(eq(scheduledTaskLaunchAttempts.id, storedReservation.id));
    await tx
      .update(scheduledTaskLaunches)
      .set({
        claimId,
        claimFence,
        claimExpiresAt: new Date(
          input.now.getTime() + SCHEDULED_LAUNCH_CLAIM_LEASE_MS,
        ),
        claimOrigin: "tick",
        latestOutcome: "claimed",
        errorCode: null,
        errorMessage: null,
        updatedAt: input.now,
      })
      .where(eq(scheduledTaskLaunches.id, row.id));
    await tx.insert(scheduledTaskLaunchEvents).values({
      id: crypto.randomUUID(),
      scheduledLaunchId: row.id,
      kind: "claimed",
      actorType: "system",
      claimFence,
      metadata: { recovery: "stale_claim" },
      createdAt: input.now,
    });

    return {
      scheduledLaunchId: row.id,
      projectId: row.projectId,
      projectRepoPath: row.projectRepoPath,
      projectSlug: row.projectSlug,
      claimId,
      claimFence,
      scheduledForAt,
      launchRequest: row.launchRequest,
      reservation: {
        id: storedReservation.id,
        scheduledLaunchId: storedReservation.scheduledLaunchId,
        runId: storedReservation.runId,
        taskId: "",
        taskAttemptNumber: storedReservation.taskAttemptNumber,
        branch: storedReservation.branch,
        worktreePath: storedReservation.worktreePath,
        requestHash: storedReservation.requestHash,
        claimFence,
      },
    };
  });
}

async function terminalizeStaleDispatch(
  db: ScheduledLaunchDb,
  input: {
    scheduledLaunchId: string;
    claimFence: number | null;
    errorCode: "PRECONDITION" | "CONFLICT";
    message: string;
    now: Date;
  },
): Promise<void> {
  await db
    .update(scheduledTaskLaunches)
    .set({
      state: "Failed",
      nextAttemptAt: null,
      claimId: null,
      claimFence: null,
      claimExpiresAt: null,
      claimOrigin: null,
      latestOutcome: "failed",
      errorCode: input.errorCode,
      errorMessage: input.message,
      updatedAt: input.now,
    })
    .where(eq(scheduledTaskLaunches.id, input.scheduledLaunchId));
  await db.insert(scheduledTaskLaunchEvents).values({
    id: crypto.randomUUID(),
    scheduledLaunchId: input.scheduledLaunchId,
    kind: "failed",
    actorType: "system",
    claimFence: input.claimFence,
    errorCode: input.errorCode,
    message: input.message,
    createdAt: input.now,
  });
}

async function failOwnedRecovery(input: {
  db: ScheduledLaunchDb;
  stale: StaleDispatch;
  message: string;
  now: Date;
}): Promise<void> {
  const updated = await input.db
    .update(scheduledTaskLaunches)
    .set({
      state: "Failed",
      nextAttemptAt: null,
      claimId: null,
      claimFence: null,
      claimExpiresAt: null,
      claimOrigin: null,
      latestOutcome: "failed",
      errorCode: "PRECONDITION",
      errorMessage: input.message,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(scheduledTaskLaunches.id, input.stale.scheduledLaunchId),
        eq(scheduledTaskLaunches.claimId, input.stale.claimId),
        eq(scheduledTaskLaunches.claimFence, input.stale.claimFence),
      ),
    )
    .returning({ id: scheduledTaskLaunches.id });

  if (updated.length === 0) return;

  await input.db
    .update(scheduledTaskLaunchAttempts)
    .set({ state: "Failed", updatedAt: input.now })
    .where(eq(scheduledTaskLaunchAttempts.id, input.stale.reservation.id));
  await input.db.insert(scheduledTaskLaunchEvents).values({
    id: crypto.randomUUID(),
    scheduledLaunchId: input.stale.scheduledLaunchId,
    kind: "failed",
    actorType: "system",
    claimFence: input.stale.claimFence,
    errorCode: "PRECONDITION",
    message: input.message,
    createdAt: input.now,
  });
}

async function cleanVerifiedReservationWorktree(input: {
  db: ScheduledLaunchDb;
  stale: StaleDispatch;
  now: Date;
}): Promise<"absent" | "cleaned" | "unsafe"> {
  const { reservation, projectRepoPath, projectSlug } = input.stale;
  const expectedPath = path.join(
    worktreesRoot(),
    projectSlug,
    reservation.runId,
  );

  if (reservation.worktreePath !== expectedPath) return "unsafe";

  const worktrees = await listWorktrees(projectRepoPath);
  const worktree = worktrees.find(
    (item) => item.path === reservation.worktreePath,
  );

  if (!worktree) {
    const branchHead = await localBranchHead({
      projectRepoPath,
      branch: reservation.branch,
    });

    return branchHead === null ? "absent" : "unsafe";
  }
  if (
    worktree.branch !== `refs/heads/${reservation.branch}` ||
    worktree.locked ||
    worktree.prunable
  ) {
    return "unsafe";
  }

  const provenance = await readWorktreeProvenanceMetadata(
    reservation.worktreePath,
  );

  if (provenance.runId !== reservation.runId) return "unsafe";

  const porcelain = await statusPorcelain({
    worktreePath: reservation.worktreePath,
  });

  if (porcelain.trim() !== "") return "unsafe";

  const branchHead = await localBranchHead({
    projectRepoPath,
    branch: reservation.branch,
  });

  if (!branchHead || !input.stale.launchRequest.baseCommit) return "unsafe";
  if (branchHead !== input.stale.launchRequest.baseCommit) return "unsafe";

  await removeOwnedWorktree({
    projectRepoPath,
    worktreePath: reservation.worktreePath,
    allowedRoot: path.join(worktreesRoot(), projectSlug),
  });
  await removeBranch({ projectRepoPath, branch: reservation.branch });
  await input.db
    .update(scheduledTaskLaunchAttempts)
    .set({ state: "Cleaned", updatedAt: input.now })
    .where(eq(scheduledTaskLaunchAttempts.id, reservation.id));

  return "cleaned";
}

async function dispatchRecoveredStale(input: {
  db: ScheduledLaunchDb;
  stale: StaleDispatch;
  now: Date;
}): Promise<"Launched" | "RetryWaiting" | "Failed"> {
  const cleanup = await cleanVerifiedReservationWorktree({
    db: input.db,
    stale: input.stale,
    now: input.now,
  }).catch(async () => "unsafe" as const);

  if (cleanup === "unsafe") {
    await failOwnedRecovery({
      db: input.db,
      stale: input.stale,
      message:
        "Scheduled launch recovery could not safely verify its managed worktree",
      now: input.now,
    });

    return "Failed";
  }

  const result = await dispatchClaimedScheduledLaunch({
    projectId: input.stale.projectId,
    claimId: input.stale.claimId,
    claimFence: input.stale.claimFence,
    reservation: input.stale.reservation,
    now: input.now,
    db: input.db,
  });

  return result.state;
}

export async function dispatchDueScheduledLaunches(input?: {
  now?: Date;
  db?: ScheduledLaunchDb;
  batchSize?: number;
}): Promise<DispatchSummary> {
  const db = input?.db ?? getDb();
  const now = input?.now ?? new Date();
  const batchSize = input?.batchSize ?? DEFAULT_BATCH_SIZE;
  const summary = initialSummary();

  for (let index = 0; index < batchSize; index += 1) {
    const stale = await reclaimOneStaleDispatch({ db, now });

    if (!stale) break;

    summary.recovered += 1;
    const state = await dispatchRecoveredStale({ db, stale, now });

    if (state === "Launched") summary.launched += 1;
    if (
      state === "Launched" &&
      now.getTime() > stale.scheduledForAt.getTime()
    ) {
      summary.late += 1;
    }
    if (state === "RetryWaiting") summary.retried += 1;
    if (state === "Failed") summary.failed += 1;
  }

  const due = await listDueScheduledLaunches({ db, now, limit: batchSize });

  summary.truncated = due.truncated;
  summary.scanned = due.rows.length;

  for (const candidate of due.rows) {
    try {
      const claim = await claimScheduledLaunch({
        scheduledLaunchId: candidate.id,
        projectId: candidate.projectId,
        source: "tick",
        now,
        db,
      });

      summary.claimed += 1;
      const result = await dispatchClaimedScheduledLaunch({
        projectId: candidate.projectId,
        claimId: claim.claimId,
        claimFence: claim.claimFence,
        reservation: claim.reservation,
        now,
        db,
      });

      if (result.state === "Launched") summary.launched += 1;
      if (
        result.state === "Launched" &&
        now.getTime() > claim.scheduledForAt.getTime()
      ) {
        summary.late += 1;
      }
      if (result.state === "RetryWaiting") summary.retried += 1;
      if (result.state === "Failed") summary.failed += 1;
    } catch (error) {
      if (isExpectedClaimContention(error)) continue;

      summary.failed += 1;
      log.warn(
        {
          err: error,
          scheduledLaunchId: candidate.id,
          projectId: candidate.projectId,
        },
        "scheduled launch dispatch failed",
      );
    }
  }

  if (summary.truncated) {
    log.warn(
      { batchSize, scanned: summary.scanned },
      "scheduled launch due scan truncated",
    );
  }
  log.info(summary, "scheduled launch dispatcher completed");

  return summary;
}
