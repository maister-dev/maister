import "server-only";

import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { ExecutionHost } from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host/client";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { assertCurrentSessionBinding } from "@/lib/execution-host/session-binding";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { mintPlacement } from "@/lib/execution-host";
import {
  capForPool,
  countLiveAssistantRuns,
  countLiveRuns,
  maxConcurrentAssistantRunsCap,
} from "@/lib/scheduler";
import { scratchPromptContentBlocks } from "@/lib/scratch-runs/attachments";
import {
  normalizeScratchPrompt,
  sendScratchPromptAndProjectEvents,
} from "@/lib/scratch-runs/events";
import { scratchStepId } from "@/lib/scratch-runs/launch";
import {
  loadScratchRecoveryRows,
  respawnScratchSession,
} from "@/lib/scratch-runs/respawn";

const { runMessages, runs, scratchAttachments, scratchRuns } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "scratch-idle-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type ScratchIdleResumeClaim =
  | Readonly<{ outcome: "claimed"; assignmentId: string }>
  | Readonly<{ outcome: "queued" }>
  | Readonly<{ outcome: "noop" }>;

/**
 * The one claim for a scratch run parked by the host's permission cap
 * (`NeedsInputIdle`, dialog still `NeedsInput`), shared by the respond route and
 * the freed-slot admission gate. The caller holds the scheduler lock: the cap
 * count and the `NeedsInputIdle → Running` CAS must be one decision. A project
 * run counts against the flow/scratch pool, a project-less assistant against
 * the assistant budget. At cap the FIFO key is coalesced, never overwritten, so
 * a waiting run keeps its place.
 */
export async function claimScratchIdleResume(
  tx: Db,
  runId: string,
  opts: { host: ExecutionHost },
): Promise<ScratchIdleResumeClaim> {
  const [run] = await tx
    .select({
      status: runs.status,
      runKind: runs.runKind,
      projectId: runs.projectId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");

  if (!run || run.runKind !== "scratch" || run.status !== "NeedsInputIdle") {
    log.info(
      { runId, runKind: run?.runKind ?? null, status: run?.status ?? null },
      "scratch-idle-resume-not-parked",
    );

    return { outcome: "noop" };
  }

  const atCap = run.projectId
    ? (await countLiveRuns(tx, "flow")) >= capForPool("flow")
    : (await countLiveAssistantRuns(tx)) >= maxConcurrentAssistantRunsCap();

  if (atCap) {
    await tx
      .update(runs)
      .set({
        resumeRequestedAt: sql`coalesce(${runs.resumeRequestedAt}, now())`,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")));
    log.info(
      { runId, pool: run.projectId ? "flow" : "assistant" },
      "scratch-idle-resume-queued",
    );

    return { outcome: "queued" };
  }

  // `checkpoint_at` stays until the respawn lands: a rolled-back claim returns
  // the run to `NeedsInputIdle`, whose TTL is measured from it.
  const claimed = await tx
    .update(runs)
    .set({
      status: "Running",
      currentStepId: scratchStepId(),
      resumeRequestedAt: null,
      keepaliveUntil: null,
      resumeStartedAt: new Date(),
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")))
    .returning({ id: runs.id });

  if (claimed.length === 0) return { outcome: "noop" };
  const assignment = await mintPlacement(tx as ExecutionDb, {
    runId,
    reason: "resume",
    host: opts.host,
  });

  log.info(
    { runId, placementId: assignment.id },
    "scratch-idle-resume-claimed",
  );

  return { outcome: "claimed", assignmentId: assignment.id };
}

/**
 * The respawn half of a scratch idle resume, after its claim committed. A
 * resumed ACP session does not continue the interrupted turn: the session is
 * restored with `session/resume` and the interrupted turn's newest user row is
 * prompted again; when the agent raises the permission anew, the scratch
 * permission handler answers it from the stored row. The prompt is detached —
 * the caller answers at once. A failed create rolls the claim back to
 * `NeedsInputIdle` and rethrows (`EXECUTOR_UNAVAILABLE` is the retryable 503).
 */
export async function driveScratchIdleResume(args: {
  db: Db;
  hosts: ExecutionHosts;
  runId: string;
  assignmentId: string;
  // The respond route's success audit: committed with the resumed binding, so
  // a rolled-back claim never leaves a 202 on record.
  recordSuccessAudit?: (tx: Db) => Promise<void>;
}): Promise<void> {
  const { db, hosts, runId } = args;
  const rows = await loadScratchRecoveryRows(db, runId);

  if (!rows.acpSessionId)
    throw new MaisterError(
      "PRECONDITION",
      `scratch run has no ACP resume session: ${runId}`,
    );
  const { execution, session } = await respawnScratchSession({
    db,
    hosts,
    runId,
    assignmentId: args.assignmentId,
    acpSessionId: rows.acpSessionId,
    rows,
    observed: {
      status: "NeedsInputIdle",
      currentStepId: (rows.run.currentStepId ?? null) as string | null,
    },
    releaseReason: "scratch_idle_resume_rollback",
  });
  const now = new Date();
  const turn = await db.transaction(async (tx: Db) => {
    await assertCurrentSessionBinding(tx, {
      runId,
      sessionName: "default",
      assignmentId: args.assignmentId,
      hostSessionId: session.sessionId,
      acpSessionId: session.acpSessionId,
    });
    await tx
      .update(scratchRuns)
      .set({
        dialogStatus: "Running",
        errorCode: null,
        errorMessage: null,
        errorMetadata: null,
        updatedAt: now,
      })
      .where(eq(scratchRuns.runId, runId));
    await tx.update(runs).set({ checkpointAt: null }).where(eq(runs.id, runId));
    await args.recordSuccessAudit?.(tx);
    const [message] = await tx
      .select({
        id: runMessages.id,
        content: runMessages.content,
      })
      .from(runMessages)
      .where(and(eq(runMessages.runId, runId), eq(runMessages.role, "user")))
      .orderBy(desc(runMessages.sequence))
      .limit(1);
    const attachments = message
      ? await tx
          .select()
          .from(scratchAttachments)
          .where(eq(scratchAttachments.messageId, message.id))
          .orderBy(asc(scratchAttachments.createdAt))
      : [];

    return {
      message: (message ?? null) as { id: string; content: string } | null,
      attachments: [
        ...attachments.filter(
          (row: { kind: string }) => row.kind !== "uploaded_file",
        ),
        ...attachments.filter(
          (row: { kind: string }) => row.kind === "uploaded_file",
        ),
      ],
    };
  });
  const prompt = normalizeScratchPrompt(
    turn.message?.content ?? rows.scratch.initialPrompt ?? "",
    rows.executor.agent,
    { runId },
  );

  log.info(
    {
      runId,
      assignmentId: args.assignmentId,
      hostSessionId: session.sessionId,
      messageId: turn.message?.id ?? null,
    },
    "scratch-idle-resume-reprompting",
  );
  void (async () => {
    try {
      await sendScratchPromptAndProjectEvents({
        db,
        runId,
        sessionId: session.sessionId,
        stepId: scratchStepId(),
        prompt,
        contentBlocks: scratchPromptContentBlocks(prompt, turn.attachments),
        execution,
        owner: { variant: "recovery" },
      });
    } catch (err) {
      const { failScratchMessageTurn } = await import(
        "@/lib/scratch-runs/service"
      );

      await failScratchMessageTurn({
        db,
        runId,
        messageId: turn.message?.id ?? "",
        hostSessionId: session.sessionId,
        isLocalPackageAssistant: !rows.run.projectId,
        err,
      }).catch((failErr: unknown) =>
        log.error(
          {
            runId,
            err: failErr instanceof Error ? failErr.message : String(failErr),
          },
          "scratch idle resume re-prompt failure handling failed",
        ),
      );
      log.warn(
        {
          runId,
          code: isMaisterError(err) ? err.code : "UNKNOWN",
          err: err instanceof Error ? err.message : String(err),
        },
        "scratch-idle-resume-reprompt-failed",
      );
    }
  })();
}
