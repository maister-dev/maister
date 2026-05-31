import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  classifyScratchRecovery,
  liveScratchSupervisorSessionIds,
} from "@/lib/scratch-runs/recovery";
import { sendScratchPromptAndProjectEvents } from "@/lib/scratch-runs/events";
import { scratchStepId } from "@/lib/scratch-runs/launch";
import {
  completeScratchPromptTurn,
  markScratchCrashed,
} from "@/lib/scratch-runs/service";
import {
  checkSupervisorHealth,
  createSession,
  listSessions,
} from "@/lib/supervisor-client";

const {
  executors,
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

  const [scratchRows, workspaceRows, projectRows, executorRows, profileRows] =
    await Promise.all([
      db.select().from(scratchRuns).where(eq(scratchRuns.runId, runId)),
      db.select().from(workspaces).where(eq(workspaces.runId, runId)),
      db.select().from(projects).where(eq(projects.id, run.projectId)),
      db.select().from(executors).where(eq(executors.id, run.executorId)),
      db
        .select()
        .from(scratchCapabilityProfiles)
        .where(eq(scratchCapabilityProfiles.runId, runId)),
    ]);
  const scratch = scratchRows[0];
  const workspace = workspaceRows[0];
  const project = projectRows[0];
  const executor = executorRows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }
  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
  }
  if (!project) {
    throw new MaisterError(
      "PRECONDITION",
      `project not found: ${run.projectId}`,
    );
  }
  if (!executor) {
    throw new MaisterError(
      "PRECONDITION",
      `executor not found: ${run.executorId}`,
    );
  }

  return {
    run,
    scratch,
    workspace,
    project,
    executor,
    profile: profileRows[0] ?? null,
  };
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
    await requireActiveSession();

    const db = getDb() as unknown as Db;
    const { run, scratch, workspace, project, executor, profile } =
      await loadScratchRecoveryRows(db, runId);

    await requireProjectAction(run.projectId, "operateScratchRun");

    await assertSupervisorReady();

    const liveSessionIds = liveScratchSupervisorSessionIds(
      await listSessions(),
    );
    const action = classifyScratchRecovery({
      runStatus: run.status,
      dialogStatus: scratch.dialogStatus,
      acpSessionId: run.acpSessionId,
      supervisorSessionId: scratch.supervisorSessionId,
      workspaceRemoved: Boolean(workspace.removedAt),
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
      projectSlug: project.slug,
      worktreePath: workspace.worktreePath,
      stepId: scratchStepId(),
      executor: {
        agent: executor.agent,
        model: executor.model,
        env: executor.env ?? undefined,
        router: executor.router ?? undefined,
      },
      resumeSessionId: run.acpSessionId,
      capabilityProfilePath: profile?.materializedPath ?? undefined,
      adapterLaunch: profile?.adapterLaunch ?? undefined,
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
        prompt: body.prompt,
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
