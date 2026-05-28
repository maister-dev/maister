import "server-only";

import type { GuardConfig } from "./guards";
import type { AcpSessionState, FlowContext, StepResult } from "./types";

import { randomUUID } from "node:crypto";

import { eq, and } from "drizzle-orm";
import pino from "pino";

import { renderStrict } from "./templating";

import { getDb } from "@/lib/db/client";
import { hitlRequests, runs } from "@/lib/db/schema";
import {
  cancelPermission,
  createSession,
  deleteSession,
  sendPrompt,
  streamSession,
  type CreateSessionResult,
  type PromptResult,
  type SupervisorEvent,
  type SupervisorExecutorInput,
} from "@/lib/supervisor-client";

const log = pino({
  name: "flow-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

const STDOUT_CAP_BYTES = 1024 * 1024;

export type AgentStepLike = {
  id: string;
  type: "agent";
  mode: "new-session" | "slash-in-existing";
  prompt: string;
  pre_guards?: GuardConfig[];
  post_guards?: GuardConfig[];
};

// FIXME(any): dual drizzle-orm peer-dep variants (mirrors lib/scheduler.ts).
type DbClientLike = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type { DbClientLike };

export type RunAgentStepCtx = {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  stepId: string;
  worktreePath: string;
  executor: {
    id: string;
    agent: "claude" | "codex";
    model: string;
    env?: Record<string, string>;
    router?: "ccr";
  };
  context: FlowContext;
  sessionState: AcpSessionState;
  db?: DbClientLike;
};

export type SupervisorApi = {
  createSession: typeof createSession;
  deleteSession: typeof deleteSession;
  sendPrompt: typeof sendPrompt;
  streamSession: typeof streamSession;
  cancelPermission: typeof cancelPermission;
};

const defaultSupervisor: SupervisorApi = {
  createSession,
  deleteSession,
  sendPrompt,
  streamSession,
  cancelPermission,
};

function synthesizePermissionPrompt(toolCall: unknown): string {
  const tc = (toolCall ?? {}) as { title?: string };

  return tc.title ? `Approve ${tc.title}?` : "Approve tool call?";
}

type PermissionContext = {
  db: DbClientLike;
  runId: string;
  stepId: string;
  supervisorSessionId: string;
  cancelPermission: typeof cancelPermission;
};

async function handlePermissionRequest(
  ev: Extract<SupervisorEvent, { type: "session.permission_request" }>,
  pctx: PermissionContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const hitlRequestId = randomUUID();

  try {
    await pctx.db.transaction(async (tx: DbClientLike) => {
      await tx.insert(hitlRequests).values({
        id: hitlRequestId,
        runId: pctx.runId,
        stepId: pctx.stepId,
        kind: "permission",
        schema: {
          requestId: ev.requestId,
          options: ev.options,
          toolCall: ev.toolCall,
          supervisorSessionId: pctx.supervisorSessionId,
        },
        prompt: synthesizePermissionPrompt(ev.toolCall),
      });
      await tx
        .update(runs)
        .set({ status: "NeedsInput", currentStepId: pctx.stepId })
        .where(and(eq(runs.id, pctx.runId), eq(runs.status, "Running")));
    });
    log.info(
      {
        runId: pctx.runId,
        stepId: pctx.stepId,
        hitlRequestId,
        requestId: ev.requestId,
        supervisorSessionId: pctx.supervisorSessionId,
      },
      "permission_request persisted; run transitioned to NeedsInput",
    );

    return { ok: true } as const;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.error(
      {
        runId: pctx.runId,
        stepId: pctx.stepId,
        requestId: ev.requestId,
        err: message,
      },
      "permission persistence failed — cancelling supervisor deferred",
    );
    try {
      await pctx.cancelPermission(
        pctx.supervisorSessionId,
        ev.requestId,
        `DB_PERSIST_FAILED:${message.slice(0, 128)}`,
      );
    } catch (cancelErr) {
      const cm =
        cancelErr instanceof Error ? cancelErr.message : String(cancelErr);

      log.warn(
        {
          runId: pctx.runId,
          stepId: pctx.stepId,
          requestId: ev.requestId,
          err: cm,
        },
        "cancelPermission also failed; supervisor timeout will fire",
      );
    }
    try {
      await pctx.db
        .update(runs)
        .set({ status: "Crashed", endedAt: new Date() })
        .where(and(eq(runs.id, pctx.runId), eq(runs.status, "Running")));
    } catch (updateErr) {
      log.warn(
        {
          runId: pctx.runId,
          err:
            updateErr instanceof Error
              ? updateErr.message
              : String(updateErr),
        },
        "run-to-Crashed update failed after persist failure",
      );
    }

    return { ok: false, reason: message } as const;
  }
}

async function transitionBackToRunning(
  db: DbClientLike,
  runId: string,
): Promise<void> {
  try {
    await db
      .update(runs)
      .set({ status: "Running" })
      .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")));
  } catch (err) {
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "NeedsInput→Running update failed",
    );
  }
}

type EventConsumer = {
  abort: AbortController;
  done: Promise<void>;
  snapshot: () => string;
  reset: () => void;
  permissionPersistFailure: () => { reason: string } | null;
};

function executorToSupervisorInput(
  exec: RunAgentStepCtx["executor"],
): SupervisorExecutorInput {
  return {
    agent: exec.agent,
    model: exec.model,
    env: exec.env,
    router: exec.router,
  };
}

function appendChunk(buf: string, chunk: string): string {
  if (buf.length + chunk.length > STDOUT_CAP_BYTES) {
    const remaining = Math.max(0, STDOUT_CAP_BYTES - buf.length);

    return buf + chunk.slice(0, remaining);
  }

  return buf + chunk;
}

function startEventConsumer(
  sessionId: string,
  supervisor: SupervisorApi,
  permissionCtx?: PermissionContext,
): EventConsumer {
  const abort = new AbortController();
  let buf = "";
  let sawPermissionRequest = false;
  let persistFailure: { reason: string } | null = null;
  const pendingWork: Promise<void>[] = [];

  const done = (async () => {
    try {
      for await (const ev of supervisor.streamSession(sessionId, {
        signal: abort.signal,
      })) {
        if (ev.type === "session.permission_request" && permissionCtx) {
          sawPermissionRequest = true;
          pendingWork.push(
            handlePermissionRequest(ev, permissionCtx).then((outcome) => {
              if (!outcome.ok && !persistFailure) {
                persistFailure = { reason: outcome.reason };
              }
            }),
          );
        }
        if (ev.type === "session.update") {
          if (sawPermissionRequest && permissionCtx) {
            sawPermissionRequest = false;
            pendingWork.push(
              transitionBackToRunning(permissionCtx.db, permissionCtx.runId),
            );
          }
          const update = ev.update as {
            sessionUpdate?: string;
            content?: { type?: string; text?: string };
          } | null;

          if (
            update?.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            typeof update.content.text === "string"
          ) {
            buf = appendChunk(buf, update.content.text);
          }
        }
        if (ev.type === "session.line") {
          // Defensive: legacy raw-line events may carry text we still want to capture.
          const line = (
            ev as Extract<SupervisorEvent, { type: "session.line" }>
          ).line;

          buf = appendChunk(buf, line + "\n");
        }
        if (ev.type === "session.exited" || ev.type === "session.crashed") {
          break;
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      log.warn(
        { err: (err as Error).message, sessionId },
        "event-consumer error",
      );
    } finally {
      await Promise.allSettled(pendingWork);
    }
  })();

  return {
    abort,
    done,
    snapshot: () => buf,
    reset: () => {
      buf = "";
    },
    permissionPersistFailure: () => persistFailure,
  };
}

export async function runAgentStep(
  step: AgentStepLike,
  ctx: RunAgentStepCtx,
  supervisorApi: SupervisorApi = defaultSupervisor,
): Promise<StepResult & { acpSessionId?: string }> {
  const resolvedPrompt = renderStrict(
    step.prompt,
    ctx.context as unknown as Record<string, unknown>,
    { traceLog: log },
  );

  log.info(
    {
      runId: ctx.runId,
      stepId: ctx.stepId,
      mode: step.mode,
      promptLen: resolvedPrompt.length,
      currentSessionId: ctx.sessionState.currentSessionId,
    },
    "agent step start",
  );

  if (step.mode === "new-session") {
    return runNewSession(step, ctx, supervisorApi, resolvedPrompt);
  }

  return runSlashInExisting(step, ctx, supervisorApi, resolvedPrompt);
}

async function runNewSession(
  _step: AgentStepLike,
  ctx: RunAgentStepCtx,
  api: SupervisorApi,
  resolvedPrompt: string,
): Promise<StepResult & { acpSessionId?: string }> {
  const startedAt = Date.now();
  let session: CreateSessionResult | null = null;
  let consumer: EventConsumer | null = null;

  try {
    session = await api.createSession({
      runId: ctx.runId,
      projectSlug: ctx.projectSlug,
      worktreePath: ctx.worktreePath,
      stepId: ctx.stepId,
      executor: executorToSupervisorInput(ctx.executor),
    });

    consumer = startEventConsumer(session.sessionId, api, {
      db: ctx.db ?? getDb(),
      runId: ctx.runId,
      stepId: ctx.stepId,
      supervisorSessionId: session.sessionId,
      cancelPermission: api.cancelPermission,
    });

    let promptResult: PromptResult;

    try {
      promptResult = await api.sendPrompt(session.sessionId, {
        stepId: ctx.stepId,
        prompt: resolvedPrompt,
      });
    } finally {
      consumer.abort.abort();
      await consumer.done;
    }

    // Permission-persistence failure overrides the adapter's stopReason:
    // even if the agent gracefully ended after the cancelled tool call,
    // the run is in a Crashed state and the runner MUST surface that
    // to runFlow so the final transition to Review never happens.
    const persistFailure = consumer.permissionPersistFailure();
    const ok = !persistFailure && promptResult.stopReason === "end_turn";
    const errorCode = persistFailure
      ? ("CRASH" as const)
      : ok
        ? undefined
        : ("ACP_PROTOCOL" as const);

    if (persistFailure) {
      log.error(
        {
          runId: ctx.runId,
          stepId: ctx.stepId,
          reason: persistFailure.reason,
        },
        "permission-persistence failure propagated to step result",
      );
    }

    return {
      ok,
      stdout: consumer.snapshot(),
      vars: {},
      durationMs: Date.now() - startedAt,
      errorCode,
      acpSessionId: session.acpSessionId,
    };
  } finally {
    if (session) {
      await api
        .deleteSession(session.sessionId)
        .catch((err) =>
          log.warn(
            { err: (err as Error).message, sessionId: session?.sessionId },
            "deleteSession failed (non-fatal)",
          ),
        );
    }
  }
}

async function runSlashInExisting(
  _step: AgentStepLike,
  ctx: RunAgentStepCtx,
  api: SupervisorApi,
  resolvedPrompt: string,
): Promise<StepResult & { acpSessionId?: string }> {
  const startedAt = Date.now();

  if (ctx.sessionState.currentSessionId === null) {
    const session = await api.createSession({
      runId: ctx.runId,
      projectSlug: ctx.projectSlug,
      worktreePath: ctx.worktreePath,
      stepId: ctx.stepId,
      executor: executorToSupervisorInput(ctx.executor),
    });

    ctx.sessionState.currentSessionId = session.sessionId;
    log.info(
      {
        runId: ctx.runId,
        stepId: ctx.stepId,
        sessionId: session.sessionId,
        acpSessionId: session.acpSessionId,
      },
      "slash-in-existing primary session seeded",
    );
  }

  const sessionId = ctx.sessionState.currentSessionId;
  const consumer = startEventConsumer(sessionId, api, {
    db: ctx.db ?? getDb(),
    runId: ctx.runId,
    stepId: ctx.stepId,
    supervisorSessionId: sessionId,
    cancelPermission: api.cancelPermission,
  });

  let promptResult: PromptResult;

  try {
    promptResult = await api.sendPrompt(sessionId, {
      stepId: ctx.stepId,
      prompt: resolvedPrompt,
    });
  } finally {
    consumer.abort.abort();
    await consumer.done;
  }

  const persistFailure = consumer.permissionPersistFailure();
  const ok = !persistFailure && promptResult.stopReason === "end_turn";
  const errorCode = persistFailure
    ? ("CRASH" as const)
    : ok
      ? undefined
      : ("ACP_PROTOCOL" as const);

  if (persistFailure) {
    log.error(
      {
        runId: ctx.runId,
        stepId: ctx.stepId,
        reason: persistFailure.reason,
      },
      "permission-persistence failure propagated to step result",
    );
  }

  return {
    ok,
    stdout: consumer.snapshot(),
    vars: {},
    durationMs: Date.now() - startedAt,
    errorCode,
    acpSessionId: sessionId,
  };
}
