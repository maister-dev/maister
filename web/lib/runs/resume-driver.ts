import "server-only";

import { randomUUID } from "node:crypto";

import { eq, and, isNull } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { markNodeSucceeded } from "@/lib/flows/graph/ledger";
import { type SupervisorEvent } from "@/lib/execution-host";
import {
  createExecutionHosts,
  isFencedError,
  type BoundClient,
  type ExecutionHosts,
} from "@/lib/execution-host";
import {
  crashResumedRun,
  failResumedRun,
  rollbackResumedRun,
} from "@/lib/runs/state-transitions";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, nodeAttempts, runs } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-resume-driver",
  level: process.env.LOG_LEVEL ?? "info",
});

// M8 review finding #2: resumeRun previously left the resumed
// supervisor session unattended — no consumer reading its SSE stream,
// no prompt sent to wake the adapter, no path to auto-deliver the
// stored HITL intent. The /respond idle branch returned 202
// "resume-in-progress" but nothing was actually in progress.
//
// runResumedSession is the missing background driver. It:
//   1. opens the streamSession consumer (so events are read off the wire),
//   2. sends a continuation prompt to wake the adapter (the spike
//      contract: the cancelled permission replays on the first prompt
//      after --resume),
//   3. relies on the runner-agent's existing M8 auto-deliver path
//      (`tryAutoDeliverStoredIntent`) — but at this layer we operate
//      one step lower: we own a single supervisor session and need to
//      deliver against the new requestId AND mark the original
//      hitl_requests row's respondedAt.
//   4. transitions the run state on completion (end_turn → Review;
//      stopReason cancelled / refusal → Crashed via crashResumedRun;
//      no permission_request within
//      MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS → Crashed via the same
//      crashResumedRun watchdog).

const DEFAULT_RESUME_PROMPT_TIMEOUT_SECONDS = 60;
const RESUME_CONTINUATION_PROMPT =
  "Resuming after operator response — please continue with the prior tool call.";

function resumePromptTimeoutSeconds(): number {
  const raw = process.env.MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS;

  if (!raw) return DEFAULT_RESUME_PROMPT_TIMEOUT_SECONDS;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RESUME_PROMPT_TIMEOUT_SECONDS;
  }

  return parsed;
}

export type RunResumedSessionOptions = {
  runId: string;
  supervisorSessionId: string;
  acpSessionId: string;
  stepId: string;
  db?: Db;
  executionHosts?: ExecutionHosts;
};

type StoredIntent = {
  id: string;
  optionId: string;
  originalRequestId: string | null;
};

async function findOpenStoredIntent(
  db: Db,
  runId: string,
  stepId: string,
): Promise<StoredIntent | null> {
  const rows = await db
    .select()
    .from(hitlRequests)
    .where(and(eq(hitlRequests.runId, runId), eq(hitlRequests.stepId, stepId)));

  for (const row of rows) {
    if (row.respondedAt) continue;
    const resp = row.response as { optionId?: string } | null;
    const optionId = resp?.optionId;

    if (!optionId) continue;
    const originalRequestId =
      (row.schema as { requestId?: string } | null)?.requestId ?? null;

    return { id: row.id, optionId, originalRequestId };
  }

  return null;
}

async function markIntentDelivered(
  db: Db,
  runId: string,
  intent: StoredIntent,
  reissuedRequestId: string,
): Promise<void> {
  await db.transaction(async (tx: Db) => {
    const stamped = await tx
      .update(hitlRequests)
      .set({
        respondedAt: new Date(),
        response: {
          optionId: intent.optionId,
          _audit: {
            originalRequestId: intent.originalRequestId,
            reissuedRequestId,
            deliveredViaResume: true,
          },
        },
      })
      .where(eq(hitlRequests.id, intent.id))
      .returning({ id: hitlRequests.id });

    if (stamped.length > 0) {
      const projectRows = await tx
        .select({ projectId: runs.projectId })
        .from(runs)
        .where(eq(runs.id, runId));

      await emitWebhookEvent({
        db: tx,
        type: "hitl.responded",
        projectId: projectRows[0].projectId,
        runId,
        data: { hitlRequestId: intent.id, kind: "permission", via: "auto" },
      });
    }
  });
}

async function markIntentAbandoned(
  db: Db,
  intent: StoredIntent,
  abandonedReason: string,
): Promise<void> {
  await db
    .update(hitlRequests)
    .set({
      respondedAt: new Date(),
      response: {
        optionId: intent.optionId,
        _audit: {
          originalRequestId: intent.originalRequestId,
          abandonedReason,
        },
      },
    })
    .where(eq(hitlRequests.id, intent.id));
}

async function findOpenNodeAttempt(
  db: Db,
  runId: string,
  nodeId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        eq(nodeAttempts.nodeId, nodeId),
        isNull(nodeAttempts.endedAt),
      ),
    );

  return rows.at(-1) ?? null;
}

async function completeResumedNodeAndHandoff(
  db: Db,
  runId: string,
  resumedNodeId: string,
  capturedStdout: string,
): Promise<boolean> {
  const [openAttempt, activeSession] = await Promise.all([
    findOpenNodeAttempt(db, runId, resumedNodeId),
    loadActiveRunSession(db, runId),
  ]);

  if (!openAttempt) {
    log.warn(
      { runId, resumedNodeId },
      "completeResumedNode: no open node attempt; refusing continuation",
    );

    return false;
  }

  await markNodeSucceeded(
    openAttempt.id,
    {
      stdout: capturedStdout,
      vars: {},
      exitCode: 0,
      acpSessionId: activeSession?.acpSessionId ?? undefined,
    },
    db,
  );

  queueMicrotask(() => {
    void (async () => {
      try {
        const { runFlow } = await import("@/lib/flows/runner");

        await runFlow(runId, {
          db,
          completedResume: { targetStepId: resumedNodeId },
        });
      } catch (err) {
        log.error(
          {
            runId,
            err: err instanceof Error ? err.message : String(err),
          },
          "completeResumedStep: runFlow continuation failed",
        );
      }
    })();
  });

  return true;
}

// M8 Codex review fix #3: every resume-driver terminal transition
// must promoteNextPending — the resumed run was occupying a slot via
// NeedsInput, and the terminal write (Review/Failed/Crashed) frees it.
// Without this, Pending runs starve until some unrelated terminal
// transition happens to call the scheduler. Mirrors runFlow's
// non-fatal wrapper around promoteNextPending at runner.ts:586.
async function promoteAfterResumeTerminal(
  db: Db,
  runId: string,
  terminalKind: "Review" | "Failed" | "Crashed",
): Promise<void> {
  try {
    const { promoteNextPending } = await import("@/lib/scheduler");
    const { runFlow } = await import("@/lib/flows/runner");

    await promoteNextPending({
      db,
      runFlow: (next) => void runFlow(next, { db }),
    });
  } catch (err) {
    log.error(
      {
        runId,
        terminalKind,
        err: err instanceof Error ? err.message : String(err),
      },
      "promoteNextPending after resume terminal failed (non-fatal)",
    );
  }
}

// Run the driver loop. Caller is responsible for scheduling this in
// the background (queueMicrotask) — the /respond route returns 202
// without awaiting it.
export async function runResumedSession(
  opts: RunResumedSessionOptions,
): Promise<void> {
  const db = opts.db ?? getDb();
  const { runId, supervisorSessionId, acpSessionId, stepId } = opts;
  const startedAt = Date.now();
  const watchdogMs = resumePromptTimeoutSeconds() * 1_000;

  log.info(
    { runId, supervisorSessionId, acpSessionId, watchdogMs },
    "runResumedSession started",
  );

  // ADR-166: every host-bound call of this driver rides the client bound to
  // the run's active assignment (the generation the resume claim minted).
  const hosts = opts.executionHosts ?? createExecutionHosts({ db });
  let client: BoundClient;

  try {
    client = await hosts.forRun(runId);
  } catch (err) {
    if (isFencedError(err)) {
      log.warn({ runId }, "runResumedSession: driver-yielded — fenced");

      return;
    }
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "runResumedSession: host binding failed — rolling back to NeedsInputIdle",
    );
    await rollbackResumedRun(runId, { db });

    return;
  }
  const admin = hosts.local();

  let stopReason: string | null = null;
  let permissionDelivered = false;
  let permissionFailed = false;
  let fenced = false;
  // Wrapped in an object so the type narrows correctly when read after
  // a closure assignment — TS otherwise narrows `consumerError` to
  // `null` because it can't see closure mutations.
  const consumerErrorRef: { current: Error | null } = { current: null };
  // Capture session output so the resumed node attempt keeps the same durable
  // evidence contract as a normal graph dispatch.
  const stdoutChunks: string[] = [];
  const STDOUT_CAP_BYTES = 1024 * 1024;
  let stdoutLen = 0;
  const abort = new AbortController();

  // Watchdog: if no session.permission_request arrives within the
  // timeout, give up.
  const watchdogTimer = setTimeout(() => {
    if (!permissionDelivered) {
      log.warn(
        { runId, supervisorSessionId, watchdogMs },
        "runResumedSession: resume-prompt watchdog expired — aborting",
      );
      abort.abort();
    }
  }, watchdogMs);

  watchdogTimer.unref?.();

  const consumerPromise = (async () => {
    try {
      for await (const ev of admin.streamSession(supervisorSessionId, {
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        await handleEvent(ev);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        consumerErrorRef.current =
          err instanceof Error ? err : new Error(String(err));
        log.warn(
          { runId, err: consumerErrorRef.current.message },
          "runResumedSession consumer error",
        );
      }
    }
  })();

  async function handleEvent(ev: SupervisorEvent): Promise<void> {
    if (ev.type === "session.update") {
      // Drain text content out of update events into the stdout
      // accumulator. The agent's session.update payload shape is
      // model-specific; we conservatively cast to a record and
      // pull `text` if it's there.
      const update = ev.update as { content?: { text?: unknown } } | null;
      const text = update?.content?.text;

      if (typeof text === "string" && text.length > 0) {
        const room = STDOUT_CAP_BYTES - stdoutLen;

        if (room > 0) {
          const chunk = text.length > room ? text.slice(0, room) : text;

          stdoutChunks.push(chunk);
          stdoutLen += chunk.length;
        }
      }

      return;
    }
    if (ev.type === "session.line") {
      // Raw JSONL line — also capture for stdout snapshot to match
      // runner-agent's snapshot semantics.
      const room = STDOUT_CAP_BYTES - stdoutLen;

      if (room > 0 && ev.line.length > 0) {
        const chunk = ev.line.length > room ? ev.line.slice(0, room) : ev.line;

        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }

      return;
    }
    if (ev.type === "session.permission_request") {
      // Auto-deliver the stored intent against the new requestId.
      const intent = await findOpenStoredIntent(db, runId, stepId);

      if (!intent) {
        log.warn(
          {
            runId,
            supervisorSessionId,
            requestId: ev.requestId,
          },
          "runResumedSession: no stored intent — cancelling to keep agent moving",
        );
        try {
          await client.deliverInput(supervisorSessionId, {
            kind: "permission",
            action: "cancel",
            requestId: ev.requestId,
            reason: "no-stored-intent",
          });
        } catch (err) {
          log.warn(
            { runId, err: (err as Error).message },
            "runResumedSession: cancelPermission also failed",
          );
        }

        return;
      }

      try {
        await client.deliverInput(supervisorSessionId, {
          kind: "permission",
          action: "select",
          requestId: ev.requestId,
          optionId: intent.optionId,
        });
        await markIntentDelivered(db, runId, intent, ev.requestId);
        permissionDelivered = true;
        log.info(
          {
            runId,
            supervisorSessionId,
            originalRequestId: intent.originalRequestId,
            reissuedRequestId: ev.requestId,
            optionId: intent.optionId,
            latencyMs: Date.now() - startedAt,
          },
          "runResumedSession: stored intent auto-delivered on resumed session",
        );
      } catch (err) {
        permissionFailed = true;
        const msg = err instanceof Error ? err.message : String(err);

        log.error(
          {
            runId,
            supervisorSessionId,
            requestId: ev.requestId,
            err: msg,
          },
          "runResumedSession: deliverPermission failed — aborting",
        );
        abort.abort();
      }

      return;
    }

    if (ev.type === "session.exited") {
      // Adapter exited intentionally (e.g. reason="intentional"). The
      // promptPromise below will resolve with whatever stopReason the
      // supervisor reported — we let it.
      return;
    }

    if (ev.type === "session.crashed") {
      log.warn(
        { runId, supervisorSessionId, monotonicId: ev.monotonicId },
        "runResumedSession: supervisor reported session.crashed",
      );
      abort.abort();

      return;
    }
  }

  let promptResult: {
    stopReason: string;
    meta?: unknown;
  } | null = null;
  let promptError: Error | null = null;

  try {
    const handle = await client.prompt(supervisorSessionId, {
      stepId,
      prompt: RESUME_CONTINUATION_PROMPT,
    });

    promptResult = await handle.completion;
    stopReason = promptResult.stopReason;
    log.info(
      {
        runId,
        supervisorSessionId,
        stopReason,
        latencyMs: Date.now() - startedAt,
      },
      "runResumedSession: continuation prompt completed",
    );
  } catch (err) {
    if (isFencedError(err)) {
      // ADR-166 yield rule: a newer generation owns the run — no terminal
      // decision, no intent write, no teardown of a session that is not ours.
      fenced = true;
      log.warn({ runId }, "runResumedSession: driver-yielded — fenced");
    } else {
      promptError = err instanceof Error ? err : new Error(String(err));
      log.warn(
        { runId, err: promptError.message },
        "runResumedSession: sendPrompt failed",
      );
    }
  } finally {
    clearTimeout(watchdogTimer);
    abort.abort();
    await consumerPromise.catch(() => undefined);
  }

  // Decide the final run state.
  if (fenced) return;

  try {
    if (permissionFailed) {
      const intent = await findOpenStoredIntent(db, runId, stepId);

      if (intent) {
        await markIntentAbandoned(db, intent, "deliver-permission-failed");
      }
      const r = await failResumedRun(runId, "deliver-permission-failed", {
        db,
      });

      if (r.ok) {
        await promoteAfterResumeTerminal(db, runId, "Failed");
      }

      return;
    }

    if (promptError || consumerErrorRef.current) {
      const errMsg =
        promptError?.message ?? consumerErrorRef.current?.message ?? "unknown";
      const reason = promptError
        ? `prompt-failed:${errMsg.slice(0, 96)}`
        : `consumer-failed:${errMsg.slice(0, 96)}`;

      // M8 review pass 2 finding #2: classify retryability
      // BEFORE writing respondedAt on the stored intent. Previously we
      // unconditionally called markIntentAbandoned() and then
      // distinguished retryable vs terminal — but markIntentAbandoned
      // sets respondedAt, so on the next /respond retry the row looked
      // already-delivered and the operator's intent was permanently
      // lost. For retryable failures we keep response stored with
      // respondedAt = null AND roll the run back to NeedsInputIdle so
      // the next /respond invocation can re-resume.
      const isRetryable =
        promptError !== null &&
        isMaisterError(promptError) &&
        promptError.code === "EXECUTOR_UNAVAILABLE";

      if (isRetryable) {
        log.warn(
          { runId, reason },
          "runResumedSession: retryable prompt failure — preserving stored intent and rolling back to NeedsInputIdle",
        );
        await rollbackResumedRun(runId, { db });

        return;
      }

      // Terminal: close the stored intent + crash the run.
      const intent = await findOpenStoredIntent(db, runId, stepId);

      if (intent) {
        await markIntentAbandoned(db, intent, reason);
      }
      const cr = await crashResumedRun(runId, reason, { db });

      if (cr.ok) {
        await promoteAfterResumeTerminal(db, runId, "Crashed");
      }

      return;
    }

    if (!permissionDelivered) {
      // Adapter never re-issued the permission within the watchdog,
      // OR the prompt completed with a non-end_turn stopReason and we
      // never saw a permission_request.
      const intent = await findOpenStoredIntent(db, runId, stepId);

      if (intent) {
        await markIntentAbandoned(db, intent, "resume-prompt-no-permission");
      }
      const cr = await crashResumedRun(runId, "resume-prompt-no-permission", {
        db,
      });

      if (cr.ok) {
        await promoteAfterResumeTerminal(db, runId, "Crashed");
      }

      return;
    }

    if (stopReason === "end_turn") {
      // Persist the completed node attempt, then let the graph runner claim the
      // parked run and continue from the node's success edge.
      const capturedStdout = stdoutChunks.join("\n");
      const handedOff = await completeResumedNodeAndHandoff(
        db,
        runId,
        stepId,
        capturedStdout,
      );

      log.info(
        {
          runId,
          supervisorSessionId,
          handedOff,
          latencyMs: Date.now() - startedAt,
        },
        "runResumedSession: node completed; graph continuation handed off",
      );

      return;
    }

    // Permission was delivered but the turn didn't end cleanly — leave
    // the row in NeedsInput; the adapter may have requested another
    // permission via a fresh hitl_requests row inserted by the
    // runner-agent. (We are NOT calling the runner-agent's persistence
    // path here; if the adapter wants further interaction it will
    // re-emit a permission_request which this driver's
    // streamSession() loop already routed once. The route's normal M7
    // path handles subsequent rounds.)
    log.info(
      { runId, supervisorSessionId, stopReason },
      "runResumedSession: ended without end_turn but with permission delivered — leaving NeedsInput",
    );
  } finally {
    // Best-effort: detach from the supervisor session so the process
    // exits on its own clock. The supervisor will GC it after the
    // standard grace.
    try {
      await client.deleteSession(supervisorSessionId);
    } catch (err) {
      log.debug(
        { runId, err: (err as Error).message },
        "runResumedSession: deleteSession cleanup error (non-fatal)",
      );
    }
  }
}

// Schedule the driver in the background — used by /respond after a
// successful resumeRun. The route returns 202 immediately while this
// runs to completion in a microtask. We use queueMicrotask + a fresh
// random id correlated for log discovery.
export function scheduleResumedSessionDrive(
  opts: RunResumedSessionOptions,
): string {
  const driveId = randomUUID();

  log.info(
    {
      runId: opts.runId,
      supervisorSessionId: opts.supervisorSessionId,
      driveId,
    },
    "scheduling resumed-session driver in background",
  );
  queueMicrotask(() => {
    void runResumedSession(opts).catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);

      log.error(
        {
          runId: opts.runId,
          driveId,
          err: msg,
        },
        "runResumedSession threw to top — funneling through crashResumedRun",
      );
      // M8 Codex review fix #2 (belt-and-suspenders): any uncaught
      // throw in the live-process driver MUST land the run in a
      // terminal state. Without this, an in-process driver bug leaves
      // runs.status = 'NeedsInput' with a claimed hitl_requests row —
      // the startup-recovery sweep only catches restart-window
      // failures, not silent live-process bugs.
      try {
        const db = opts.db ?? getDb();
        const cr = await crashResumedRun(
          opts.runId,
          `driver-uncaught:${msg.slice(0, 96)}`,
          { db },
        );

        if (cr.ok) {
          await promoteAfterResumeTerminal(db, opts.runId, "Crashed");
        }
      } catch (terminalErr) {
        log.error(
          {
            runId: opts.runId,
            driveId,
            err:
              terminalErr instanceof Error
                ? terminalErr.message
                : String(terminalErr),
          },
          "crashResumedRun also threw — run state is inconsistent, startup recovery will catch",
        );
      }
    });
  });

  return driveId;
}
