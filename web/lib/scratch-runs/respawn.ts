import "server-only";

import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { ScratchCreateOwner } from "@/lib/execution-host/create-owner-contract";
import type { ScratchCreateContinuation } from "./create-continuation";

import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { assertScratchCreateContinuation } from "./create-continuation";

import {
  mergeRunnerAdapterLaunch,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { projectPrivateCreateFailure } from "@/lib/execution-host/private-create-failure";
import {
  isFencedError,
  publishCapabilityBundle,
  releaseAssignmentForRun,
} from "@/lib/execution-host";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import { scratchStepId } from "@/lib/scratch-runs/launch";
import { SessionCreatePending } from "@/lib/execution-host/owned-session-create";

const {
  localPackages,
  platformAcpRunners,
  projects,
  runs,
  scratchCapabilityProfiles,
  scratchRuns,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "scratch-respawn",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = {
  select: any;
  update: any;
  transaction: any;
};

export type ScratchLaunchExecutor = {
  agent: AdapterId;
  model: string;
  env?: Record<string, string>;
};

type ScratchRecoveredRunner = {
  executor: ScratchLaunchExecutor;
  snapshot: RunnerSnapshot;
};

type ScratchRecoveryCreateContinuation = Extract<
  ScratchCreateContinuation,
  { kind: "recovery" | "package_recovery" }
>;

export type ScratchRespawnRows = Awaited<
  ReturnType<typeof loadScratchRecoveryRows>
>;

/** Everything a respawn of the run's `default` session needs, read from
 * server state only: the run, its dialog, the workspace (or, for a project-less
 * assistant, the local package's working dir), the runner snapshot and the ACP
 * resume handle. Shared by Recover and the idle resume after a host park. */
export async function loadScratchRecoveryRows(db: Db, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }
  if (run.runKind !== "scratch") {
    throw new MaisterError("PRECONDITION", `run is not scratch: ${runId}`);
  }

  const [scratchRows, workspaceRows, profileRows] = await Promise.all([
    db.select().from(scratchRuns).where(eq(scratchRuns.runId, runId)),
    db.select().from(workspaces).where(eq(workspaces.runId, runId)),
    db
      .select()
      .from(scratchCapabilityProfiles)
      .where(eq(scratchCapabilityProfiles.runId, runId)),
  ]);
  const scratch = scratchRows[0];
  const activeSession = await loadActiveRunSession(db, runId);
  const recoveredRunner = await loadScratchLaunchExecutor(
    db,
    activeSession,
    runId,
  );

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }

  // ADR-097: a project-less local-package assistant run has NO workspace row and
  // NO project — its cwd + sole confinement root is the local package's
  // git-backed working_dir. Resolve a workspace-/project-SHAPED view (and carry
  // confineRoot) so the resume path stays uniform; a project run keeps its rows.
  let worktreePath: string;
  let workspaceRemoved: boolean;
  let projectSlug: string;
  let confineRoot: string | undefined;

  if (run.localPackageId) {
    const pkgRows = await db
      .select()
      .from(localPackages)
      .where(eq(localPackages.id, run.localPackageId));
    const pkg = pkgRows[0];

    if (!pkg) {
      throw new MaisterError(
        "PRECONDITION",
        `local package not found for assistant run: ${runId}`,
      );
    }
    worktreePath = pkg.workingDir;
    workspaceRemoved = false;
    projectSlug = pkg.slug;
    confineRoot = pkg.workingDir;
  } else {
    const workspace = workspaceRows[0];
    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.id, run.projectId));
    const project = projectRows[0];

    if (!workspace) {
      throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
    }
    if (!project) {
      throw new MaisterError(
        "PRECONDITION",
        `project not found: ${run.projectId}`,
      );
    }
    worktreePath = workspace.worktreePath;
    workspaceRemoved = Boolean(workspace.removedAt);
    projectSlug = project.slug;
    confineRoot = undefined;
  }

  return {
    run,
    scratch,
    worktreePath,
    workspaceRemoved,
    projectSlug,
    confineRoot,
    acpSessionId: activeSession?.acpSessionId ?? null,
    hostSessionId: activeSession?.hostSessionId ?? null,
    executor: recoveredRunner.executor,
    runnerSnapshot: recoveredRunner.snapshot,
    profile: profileRows[0] ?? null,
  };
}

async function loadScratchLaunchExecutor(
  db: Db,
  active: {
    runnerSnapshot: RunnerSnapshot | null;
    runnerId: string | null;
  } | null,
  runId: string,
): Promise<ScratchRecoveredRunner> {
  if (active?.runnerSnapshot) {
    return {
      executor: {
        agent: active.runnerSnapshot.capabilityAgent as AdapterId,
        model: active.runnerSnapshot.model,
      },
      snapshot: active.runnerSnapshot,
    };
  }

  if (active?.runnerId) {
    const runnerRows = await db
      .select()
      .from(platformAcpRunners)
      .where(eq(platformAcpRunners.id, active.runnerId));
    const runner = runnerRows[0];

    if (!runner) {
      throw new MaisterError(
        "PRECONDITION",
        `ACP runner not found: ${active.runnerId}`,
      );
    }

    return {
      executor: {
        agent: runner.capabilityAgent,
        model: runner.model,
      },
      snapshot: {
        id: runner.id,
        adapter: runner.adapter,
        capabilityAgent: runner.capabilityAgent,
        model: runner.model,
        provider: runner.provider,
        providerKind: runner.provider.kind,
        permissionPolicy: runner.permissionPolicy,
      },
    };
  }

  throw new MaisterError(
    "PRECONDITION",
    `no ACP runner snapshot found for run ${runId}`,
  );
}

/** The pre-claim state a failed respawn restores. `resumeRequestedAt` is the
 * queue key an idle-resume claim cleared (absent for Recover, which never
 * touches it). */
export type ScratchClaimObserved = {
  status: "Crashed" | "NeedsInputIdle";
  currentStepId: string | null;
  resumeRequestedAt?: Date | null;
};

/** A failed respawn after a claim: `Running` → the observed pre-claim status
 * (predicated on `Running` so a concurrent transition is never clobbered) and
 * the never-driven generation released, in ONE tx — mirrors rollbackResumedRun.
 * A private create may already have marked the dialog Starting; restore that
 * unacknowledged handoff while preserving the previous session binding. */
export async function rollbackScratchClaim(
  db: Db,
  runId: string,
  assignmentId: string,
  observed: ScratchClaimObserved,
  releaseReason: string,
  failure?: Readonly<{
    commandId: string;
    error: unknown;
    assignmentEpoch?: number;
  }>,
): Promise<void> {
  const projectedFailure = failure
    ? projectPrivateCreateFailure(failure.error, {
        runId,
        assignmentId,
        ...(failure.assignmentEpoch === undefined
          ? {}
          : { assignmentEpoch: failure.assignmentEpoch }),
        stage: "session_create",
      })
    : null;

  await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({
        status: observed.status,
        currentStepId: observed.currentStepId,
        resumeStartedAt: null,
        ...(observed.resumeRequestedAt === undefined
          ? {}
          : { resumeRequestedAt: observed.resumeRequestedAt }),
      })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.status, "Running"),
          eq(runs.executionAssignmentId, assignmentId),
        ),
      )
      .returning({ id: runs.id });

    if (rows.length === 0) return;

    await tx
      .update(scratchRuns)
      .set({
        dialogStatus: observed.status === "Crashed" ? "Crashed" : "NeedsInput",
        updatedAt: new Date(),
        ...(failure && projectedFailure
          ? {
              errorCode: projectedFailure.code,
              errorMessage: projectedFailure.message,
              errorMetadata: {
                ...projectedFailure.details,
                diagnosticStage: projectedFailure.details?.stage ?? null,
                stage: "session_create",
                commandId: failure.commandId,
                assignmentId,
              },
            }
          : {}),
      })
      .where(
        and(
          eq(scratchRuns.runId, runId),
          eq(scratchRuns.dialogStatus, "Starting"),
        ),
      );

    await releaseAssignmentForRun(
      tx as unknown as ExecutionDb,
      runId,
      releaseReason,
    );
  });
  log.info(
    { runId, restoredStatus: observed.status },
    "scratch-claim-rolled-back",
  );
}

/** Respawns the run's `default` session with `session/resume` on the ACP
 * handle, through the client bound to the placement the caller's claim minted.
 * A failed create rolls the claim back to `observed` — except a fenced one,
 * whose run belongs to a newer generation (ADR-166 E-EH-11). */
export async function respawnScratchSession(args: {
  db: Db;
  hosts: ExecutionHosts;
  runId: string;
  assignmentId: string;
  // The conversation to restore. Required: a respawn without it would be a
  // `session/new` that silently orphans the dialog.
  acpSessionId: string;
  rows: Pick<
    ScratchRespawnRows,
    "executor" | "runnerSnapshot" | "profile" | "run"
  >;
  continuation: ScratchRecoveryCreateContinuation;
  recordSuccessAudit?: (tx: ExecutionDb) => Promise<void>;
  observed: ScratchClaimObserved;
  releaseReason: string;
}) {
  const { db, runId, rows } = args;
  const execution = await args.hosts.executionFor(runId, {
    assignmentId: args.assignmentId,
  });

  const packageId = rows.run.localPackageId as string | null;
  const [pkg] = packageId
    ? await db
        .select()
        .from(localPackages)
        .where(eq(localPackages.id, packageId))
    : [];
  const owner: ScratchCreateOwner = packageId
    ? {
        variant: "package_scratch",
        scratchRunId: runId,
        turnId: args.assignmentId,
        promptOrdinal: 0,
        localPackageId: packageId,
        postprocessActionId: randomUUID(),
        lockGeneration: pkg?.lockedBySession ?? "",
      }
    : {
        variant: "scratch",
        scratchRunId: runId,
        turnId: args.assignmentId,
        promptOrdinal: 0,
      };
  const continuation: ScratchRecoveryCreateContinuation = {
    ...args.continuation,
    kind: packageId ? "package_recovery" : "recovery",
  };

  try {
    if (packageId && !pkg?.lockedBySession)
      throw new MaisterError(
        "CONFLICT",
        "Reopen the local package and acquire its edit lock before recovering the assistant",
        { details: { reason: "assistant_edit_lock_required", runId } },
      );
    const session = await execution.client.createOwnedSession(
      owner,
      async () => {
        const capabilityBundle = rows.profile?.materializedPath
          ? await publishCapabilityBundle({
              client: execution.client,
              runId,
              sourceId: "scratch-session",
              profileLogicalName: "scratch-capability-profile.json",
              profilePath: join(rows.profile.materializedPath, "profile.json"),
              instructionsLogicalName: "scratch-capability-instructions.md",
              instructionsPath: join(
                rows.profile.materializedPath,
                "instructions.md",
              ),
            })
          : undefined;

        return {
          ...(packageId ? { readOnlySession: true } : {}),
          stepId: scratchStepId(),
          executor: rows.executor,
          runner: runnerSupervisorInput({ snapshot: rows.runnerSnapshot }),
          resumeSessionId: args.acpSessionId,
          capabilityProfileObjectId: capabilityBundle?.profileObjectId,
          capabilityInstructionsObjectId:
            capabilityBundle?.instructionsObjectId,
          adapterLaunch: mergeRunnerAdapterLaunch(
            rows.runnerSnapshot,
            rows.profile?.adapterLaunch ?? undefined,
          ),
        };
      },
      {
        prepareContinuation: async () => continuation,
        assertCommit: async (tx) => {
          await assertScratchCreateContinuation(
            tx,
            execution.client,
            owner,
            continuation,
          );
          await args.recordSuccessAudit?.(tx);
        },
      },
    );

    log.info(
      {
        runId,
        assignmentId: args.assignmentId,
        hostSessionId: session.sessionId,
      },
      "scratch-session-respawned",
    );

    return { execution, session, createOwner: owner };
  } catch (err) {
    if (err instanceof SessionCreatePending) throw err;
    if (isFencedError(err)) {
      log.warn({ runId, assignmentId: args.assignmentId }, "driver-yielded");
      throw err;
    }
    await rollbackScratchClaim(
      db,
      runId,
      args.assignmentId,
      args.observed,
      args.releaseReason,
    );
    throw err;
  }
}
