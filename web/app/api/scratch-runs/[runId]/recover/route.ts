import "server-only";

import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  mergeRunnerAdapterLaunch,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  classifyScratchRecovery,
  liveScratchSupervisorSessionIds,
} from "@/lib/scratch-runs/recovery";
import {
  normalizeScratchPrompt,
  sendScratchPromptAndProjectEvents,
} from "@/lib/scratch-runs/events";
import { scratchStepId } from "@/lib/scratch-runs/launch";
import {
  loadActiveRunSession,
  persistRunSessionAcpSessionId,
} from "@/lib/runs/active-run-session";
import {
  assertLocalPackageAssistantActor,
  completeScratchPromptTurn,
  markScratchCrashed,
} from "@/lib/scratch-runs/service";
import {
  createExecutionHosts,
  isFencedError,
  localHost,
  mintPlacement,
  releaseAssignmentForRun,
} from "@/lib/execution-host";

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
  name: "api-scratch-recover",
  level: process.env.LOG_LEVEL ?? "info",
});

const recoverBodySchema = z
  .object({
    prompt: z.string().min(1).max(60_000).optional(),
  })
  .strict();

type RecoverBody = z.infer<typeof recoverBodySchema>;
type RouteParams = { params: Promise<{ runId: string }> };
type Db = {
  select: any;
  update: any;
  transaction: any;
};

type ScratchLaunchExecutor = {
  agent: AdapterId;
  model: string;
  env?: Record<string, string>;
};
type ScratchRecoveredRunner = {
  executor: ScratchLaunchExecutor;
  snapshot: RunnerSnapshot;
};

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "POST /api/scratch-runs/[runId]/recover");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadScratchRecoveryRows(db: Db, runId: string) {
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

// ADR-166: the recover re-enters the run under a new driver generation
// (`scratch_recover`) minted inside the Running flip; the resumed session is
// created through the client bound to that assignment (an unavailable host
// refuses the recover before the claim).

// A failed create after the claim: Running → the observed pre-claim row
// (predicated on Running so a concurrent transition is never clobbered) and
// the never-driven `scratch_recover` generation released, in ONE tx — mirrors
// rollbackResumedRun. The claim never touched `scratch_runs`, so the stored
// supervisor session id is exactly as it was.
async function rollbackScratchRecover(
  db: Db,
  runId: string,
  observed: { status: string; currentStepId: string | null },
): Promise<void> {
  await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({ status: observed.status, currentStepId: observed.currentStepId })
      .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
      .returning({ id: runs.id });

    if (rows.length === 0) return;

    await releaseAssignmentForRun(
      tx as unknown as ExecutionDb,
      runId,
      "scratch_recover_rollback",
    );
  });
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;
  let body: RecoverBody;

  try {
    body = recoverBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
      runId,
    );
  }

  try {
    const user = await requireActiveSession();

    const db = getDb() as unknown as Db;
    const {
      run,
      scratch,
      workspaceRemoved,
      executor,
      runnerSnapshot,
      acpSessionId,
      profile,
    } = await loadScratchRecoveryRows(db, runId);

    // ADR-097: project scratch runs keep the project-scoped operate gate; a
    // project-less assistant run is bound to its launching user AND a live
    // working-dir lock — driving a resume writes into the locked dir.
    if (run.projectId) {
      await requireProjectAction(run.projectId, "operateScratchRun");
    } else {
      await assertLocalPackageAssistantActor(run, user.id, {
        requireLock: true,
      });
    }

    const hosts = createExecutionHosts({ db: db as unknown as ExecutionDb });
    const placementHost = await localHost({
      db: db as unknown as ExecutionDb,
      transport: hosts.transport,
    });

    const liveSessionIds = liveScratchSupervisorSessionIds(
      await hosts.local().listSessions(),
    );
    const action = classifyScratchRecovery({
      runStatus: run.status,
      dialogStatus: scratch.dialogStatus,
      acpSessionId,
      supervisorSessionId: scratch.supervisorSessionId,
      workspaceRemoved,
      liveSupervisorSessionIds: liveSessionIds,
    });

    if (action === "open") {
      return NextResponse.json({
        runId,
        action,
        dialogStatus: scratch.dialogStatus,
      });
    }
    if (action !== "recover") {
      throw new MaisterError(
        "PRECONDITION",
        `scratch run cannot be recovered; action=${action}`,
      );
    }
    if (!body.prompt) {
      throw new MaisterError(
        "CONFIG",
        "prompt is required to recover a scratch session",
      );
    }
    if (!acpSessionId) {
      throw new MaisterError(
        "PRECONDITION",
        `scratch run has no ACP resume session: ${runId}`,
      );
    }

    // Claim first: CAS the OBSERVED status → Running and mint the
    // `scratch_recover` generation in the same tx (a concurrent recover loses
    // the CAS → 409). The create then rides the client bound to that
    // generation; a create failure rolls the claim back. The ADR-097
    // working-dir confinement rides the adopted handle (directory adoption of
    // the package dir), no longer a wire field.
    const observed = {
      status: run.status as string,
      currentStepId: (run.currentStepId ?? null) as string | null,
    };
    const claimed = await db.transaction(async (tx: Db) => {
      const rows = await tx
        .update(runs)
        .set({
          status: "Running",
          currentStepId: scratchStepId(),
        })
        .where(and(eq(runs.id, runId), eq(runs.status, observed.status)))
        .returning({ id: runs.id });

      if (rows.length === 0) return null;

      return mintPlacement(tx as unknown as ExecutionDb, {
        runId,
        reason: "scratch_recover",
        host: placementHost,
      });
    });

    if (!claimed) {
      throw new MaisterError(
        "CONFLICT",
        `scratch run ${runId} left ${observed.status} concurrently — recover refused`,
      );
    }

    const execution = await hosts.executionFor(runId, {
      assignmentId: claimed.id,
    });
    let session: Awaited<ReturnType<typeof execution.client.createSession>>;

    try {
      session = await execution.client.createSession({
        stepId: scratchStepId(),
        executor,
        runner: runnerSupervisorInput({ snapshot: runnerSnapshot }),
        resumeSessionId: acpSessionId,
        capabilityProfilePath: profile?.materializedPath ?? undefined,
        adapterLaunch: mergeRunnerAdapterLaunch(
          runnerSnapshot,
          profile?.adapterLaunch ?? undefined,
        ),
      });
    } catch (err) {
      // ADR-166 E-EH-11: a fenced create means a newer generation owns the
      // run — its claim is not ours to roll back.
      if (isFencedError(err)) {
        log.warn({ runId, assignmentId: claimed.id }, "driver-yielded");
        throw err;
      }
      await rollbackScratchRecover(db, runId, observed);
      throw err;
    }
    const now = new Date();

    await db.transaction(async (tx: Db) => {
      await persistRunSessionAcpSessionId(
        tx,
        runId,
        "default",
        session.acpSessionId,
      );
      await tx
        .update(scratchRuns)
        .set({
          dialogStatus: "Running",
          supervisorSessionId: session.sessionId,
          errorCode: null,
          errorMessage: null,
          errorMetadata: null,
          updatedAt: now,
        })
        .where(eq(scratchRuns.runId, runId));
    });

    try {
      const promptResult = await sendScratchPromptAndProjectEvents({
        runId,
        sessionId: session.sessionId,
        stepId: scratchStepId(),
        prompt: normalizeScratchPrompt(body.prompt, executor.agent, { runId }),
        execution,
      });

      const dialogStatus = await completeScratchPromptTurn({ db, runId });

      return NextResponse.json(
        {
          runId,
          action,
          dialogStatus,
          stopReason: promptResult.stopReason,
        },
        { status: 202 },
      );
    } catch (err) {
      // A fenced turn belongs to a superseded generation — its run state is
      // not ours to crash (E-EH-11).
      if (isFencedError(err)) {
        log.warn({ runId, assignmentId: claimed.id }, "driver-yielded");
        throw err;
      }
      await markScratchCrashed({
        db,
        runId,
        err,
        clearSupervisorSession: true,
      }).catch((markErr) =>
        log.error(
          {
            runId,
            markErr:
              markErr instanceof Error ? markErr.message : String(markErr),
          },
          "failed to mark scratch recovery prompt failure",
        ),
      );
      throw err;
    }
  } catch (err) {
    return errorResponse(err, runId);
  }
}
