import "server-only";

import type { AdapterId } from "@/lib/acp-runners/adapter-support";
import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";

import { eq } from "drizzle-orm";
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
  assertLocalPackageAssistantActor,
  completeScratchPromptTurn,
  markScratchCrashed,
} from "@/lib/scratch-runs/service";
import {
  checkSupervisorHealth,
  createSession,
  listSessions,
} from "@/lib/supervisor-client";

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
  router?: "ccr";
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
  const recoveredRunner = await loadScratchLaunchExecutor(db, run, runId);

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
    executor: recoveredRunner.executor,
    runnerSnapshot: recoveredRunner.snapshot,
    profile: profileRows[0] ?? null,
  };
}

async function loadScratchLaunchExecutor(
  db: Db,
  run: Record<string, any>,
  runId: string,
): Promise<ScratchRecoveredRunner> {
  if (run.runnerSnapshot) {
    return {
      executor: {
        agent: run.runnerSnapshot.capabilityAgent,
        model: run.runnerSnapshot.model,
        router: run.runnerSnapshot.sidecarId ? "ccr" : undefined,
      },
      snapshot: run.runnerSnapshot,
    };
  }

  if (run.runnerId) {
    const runnerRows = await db
      .select()
      .from(platformAcpRunners)
      .where(eq(platformAcpRunners.id, run.runnerId));
    const runner = runnerRows[0];

    if (!runner) {
      throw new MaisterError(
        "PRECONDITION",
        `ACP runner not found: ${run.runnerId}`,
      );
    }

    return {
      executor: {
        agent: runner.capabilityAgent,
        model: runner.model,
        router: runner.sidecarId ? "ccr" : undefined,
      },
      snapshot: {
        id: runner.id,
        adapter: runner.adapter,
        capabilityAgent: runner.capabilityAgent,
        model: runner.model,
        provider: runner.provider,
        providerKind: runner.provider.kind,
        permissionPolicy: runner.permissionPolicy,
        sidecarId: runner.sidecarId,
      },
    };
  }

  throw new MaisterError(
    "PRECONDITION",
    `no ACP runner snapshot found for run ${runId}`,
  );
}

async function assertSupervisorReady(): Promise<void> {
  const platformStatus = await checkSupervisorHealth();

  if (platformStatus.kind === "unavailable") {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      `supervisor unavailable (${platformStatus.reason}): ${platformStatus.message}`,
    );
  }
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
      worktreePath,
      workspaceRemoved,
      projectSlug,
      confineRoot,
      executor,
      runnerSnapshot,
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

    await assertSupervisorReady();

    const liveSessionIds = liveScratchSupervisorSessionIds(
      await listSessions(),
    );
    const action = classifyScratchRecovery({
      runStatus: run.status,
      dialogStatus: scratch.dialogStatus,
      acpSessionId: run.acpSessionId,
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
    if (!run.acpSessionId) {
      throw new MaisterError(
        "PRECONDITION",
        `scratch run has no ACP resume session: ${runId}`,
      );
    }

    const session = await createSession({
      runId,
      projectSlug,
      worktreePath,
      // ADR-097: re-assert the assistant's working-dir confinement on resume
      // (undefined for project runs, preserving their prior behavior).
      confineRoot,
      stepId: scratchStepId(),
      executor,
      runner: runnerSupervisorInput({ snapshot: runnerSnapshot }),
      resumeSessionId: run.acpSessionId,
      capabilityProfilePath: profile?.materializedPath ?? undefined,
      adapterLaunch: mergeRunnerAdapterLaunch(
        runnerSnapshot,
        profile?.adapterLaunch ?? undefined,
      ),
    });
    const now = new Date();

    await db.transaction(async (tx: Db) => {
      await tx
        .update(runs)
        .set({
          status: "Running",
          acpSessionId: session.acpSessionId,
          currentStepId: scratchStepId(),
        })
        .where(eq(runs.id, runId));
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
