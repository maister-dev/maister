import "server-only";

import pino from "pino";

import {
  createSession,
  deleteSession,
  sendPrompt,
  streamSession,
  type CreateSessionResult,
  type PromptResult,
  type SupervisorEvent,
  type SupervisorExecutorInput,
} from "@/lib/supervisor-client";

import { renderStrict } from "./templating";

import type { GuardConfig } from "./guards";
import type {
  AcpSessionState,
  FlowContext,
  StepResult,
} from "./types";

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
};

export type SupervisorApi = {
  createSession: typeof createSession;
  deleteSession: typeof deleteSession;
  sendPrompt: typeof sendPrompt;
  streamSession: typeof streamSession;
};

const defaultSupervisor: SupervisorApi = {
  createSession,
  deleteSession,
  sendPrompt,
  streamSession,
};

type EventConsumer = {
  abort: AbortController;
  done: Promise<void>;
  snapshot: () => string;
  reset: () => void;
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
): EventConsumer {
  const abort = new AbortController();
  let buf = "";

  const done = (async () => {
    try {
      for await (const ev of supervisor.streamSession(sessionId, {
        signal: abort.signal,
      })) {
        if (ev.type === "session.update") {
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
          const line = (ev as Extract<SupervisorEvent, { type: "session.line" }>)
            .line;

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
    }
  })();

  return {
    abort,
    done,
    snapshot: () => buf,
    reset: () => {
      buf = "";
    },
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

    consumer = startEventConsumer(session.sessionId, api);

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

    const ok = promptResult.stopReason === "end_turn";

    return {
      ok,
      stdout: consumer.snapshot(),
      vars: {},
      durationMs: Date.now() - startedAt,
      errorCode: ok ? undefined : "ACP_PROTOCOL",
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
  const consumer = startEventConsumer(sessionId, api);

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

  const ok = promptResult.stopReason === "end_turn";

  return {
    ok,
    stdout: consumer.snapshot(),
    vars: {},
    durationMs: Date.now() - startedAt,
    errorCode: ok ? undefined : "ACP_PROTOCOL",
    acpSessionId: sessionId,
  };
}
