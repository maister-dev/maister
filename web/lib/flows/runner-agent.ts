import "server-only";

import type { CapabilityAgent } from "@/lib/config.schema";
import type { ScratchAdapterLaunch } from "@/lib/db/schema";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { GuardConfig } from "./guards";
import type { AcpSessionState, FlowContext, StepResult } from "./types";

import { randomUUID } from "node:crypto";

import { eq, and, isNull, isNotNull } from "drizzle-orm";
import pino from "pino";

import { renderStrict } from "./templating";

import {
  completeHitlAssignmentFromCurrentActor,
  createHitlAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import { hitlRequests, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { markCheckpointedFromExit } from "@/lib/runs/state-transitions";
import {
  cancelPermission,
  createSession,
  deleteSession,
  deliverPermission,
  sendPrompt,
  streamSession,
  type CreateSessionResult,
  type PromptResult,
  type SupervisorEvent,
  type SupervisorExecutorInput,
  type SupervisorRunnerInput,
} from "@/lib/supervisor-client";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

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
type DbClientLike = any;
export type { DbClientLike };

export type RunAgentStepCtx = {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  stepId: string;
  nodeAttemptId?: string;
  worktreePath: string;
  // M34 (ADR-089): the node's `settings.agent` catalog binding — resolved at
  // dispatch (session-mode prompt substitution / subagent materialization).
  agentBinding?: { id: string };
  executor: {
    id: string;
    agent: CapabilityAgent;
    model: string;
    env?: Record<string, string>;
    router?: "ccr";
  };
  runner?: SupervisorRunnerInput;
  context: FlowContext;
  sessionState: AcpSessionState;
  capabilityProfilePath?: string;
  adapterLaunch?: ScratchAdapterLaunch;
  mcpServers?: AgentMcpServer[];
  profileDigest?: string;
  // M30 (ADR-081): rework `resume` — respawn the adapter and restore the
  // prior attempt's conversation via the ACP session/resume protocol call.
  // Unresumable → fall back to a fresh session and flag sessionFallback.
  resumeSessionId?: string;
  db?: DbClientLike;
};

export type SupervisorApi = {
  createSession: typeof createSession;
  deleteSession: typeof deleteSession;
  sendPrompt: typeof sendPrompt;
  streamSession: typeof streamSession;
  cancelPermission: typeof cancelPermission;
  deliverPermission: typeof deliverPermission;
};

const defaultSupervisor: SupervisorApi = {
  createSession,
  deleteSession,
  sendPrompt,
  streamSession,
  cancelPermission,
  deliverPermission,
};

// M14 T4.5: a long-living (slash-in-existing) session may not silently serve a
// second AI node whose resolved capability profile differs from the one the
// session was materialized with. Allow-list: reuse permitted iff the digests
// are equal, or either side is undefined (a non-capability node, or the first
// materialized node seeding a fresh session). Mismatch ⇒ CONFIG: the Flow author
// must declare a session boundary.
export function assertSessionProfileConsistent(
  existingDigest: string | undefined,
  incomingDigest: string | undefined,
): void {
  if (
    existingDigest !== undefined &&
    incomingDigest !== undefined &&
    existingDigest !== incomingDigest
  ) {
    throw new MaisterError(
      "CONFIG",
      `capability profile changed mid-session (session digest ${existingDigest} != node digest ${incomingDigest}); a long-living session requires a declared session boundary`,
    );
  }
}

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
  deliverPermission: typeof deliverPermission;
};

// M8 T11 / D9: look for a prior hitl_requests row where the operator
// already submitted an intent (response set) but it has not been
// delivered (respondedAt null). If found, auto-deliver against the
// NEW requestId and mark the ORIGINAL row's respondedAt with audit.
async function tryAutoDeliverStoredIntent(
  ev: Extract<SupervisorEvent, { type: "session.permission_request" }>,
  pctx: PermissionContext,
): Promise<{ delivered: boolean; reason?: string }> {
  const priorRows = await pctx.db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, pctx.runId),
        eq(hitlRequests.stepId, pctx.stepId),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
        isNotNull(hitlRequests.response),
      ),
    )
    .limit(1);
  const prior = priorRows[0];

  if (!prior) return { delivered: false };

  const stored = prior.response as { optionId?: string } | null;
  const optionId = stored?.optionId;

  if (!optionId) return { delivered: false };

  const priorRequestId =
    (prior.schema as { requestId?: string } | null)?.requestId ?? null;
  const startedAt = Date.now();

  try {
    await pctx.deliverPermission(
      pctx.supervisorSessionId,
      ev.requestId,
      optionId,
    );
    await pctx.db.transaction(async (tx: DbClientLike) => {
      const stamped = await tx
        .update(hitlRequests)
        .set({
          respondedAt: new Date(),
          response: {
            optionId,
            _audit: {
              originalRequestId: priorRequestId,
              reissuedRequestId: ev.requestId,
              deliveredViaResume: true,
            },
          },
        })
        .where(eq(hitlRequests.id, prior.id))
        .returning({ id: hitlRequests.id });

      if (stamped.length > 0) {
        const projectRows = await tx
          .select({ projectId: runs.projectId })
          .from(runs)
          .where(eq(runs.id, pctx.runId));

        await emitWebhookEvent({
          db: tx,
          type: "hitl.responded",
          projectId: projectRows[0].projectId,
          runId: pctx.runId,
          data: { hitlRequestId: prior.id, kind: prior.kind, via: "auto" },
        });
      }
    });
    await completeHitlAssignmentFromCurrentActor({
      db: pctx.db,
      hitlRequestId: prior.id,
      eventKind: "responded",
      payload: {
        optionId,
        originalRequestId: priorRequestId,
        reissuedRequestId: ev.requestId,
        deliveredViaResume: true,
      },
    });

    log.info(
      {
        runId: pctx.runId,
        stepId: pctx.stepId,
        originalRequestId: priorRequestId,
        reissuedRequestId: ev.requestId,
        supervisorSessionId: pctx.supervisorSessionId,
        latencyMs: Date.now() - startedAt,
      },
      "auto-delivered stored intent on resumed session",
    );

    return { delivered: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.warn(
      {
        runId: pctx.runId,
        stepId: pctx.stepId,
        originalRequestId: priorRequestId,
        reissuedRequestId: ev.requestId,
        err: message,
      },
      "auto-deliver supervisor 5xx — leaving intent un-acked; agent will retry",
    );

    return { delivered: false, reason: message };
  }
}

async function handlePermissionRequest(
  ev: Extract<SupervisorEvent, { type: "session.permission_request" }>,
  pctx: PermissionContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const auto = await tryAutoDeliverStoredIntent(ev, pctx);

  if (auto.delivered) {
    return { ok: true } as const;
  }

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
      await createHitlAssignmentForRun({
        db: tx,
        runId: pctx.runId,
        hitlRequestId,
        stepId: pctx.stepId,
        actionKind: "permission",
        roleRefs: [],
        title: synthesizePermissionPrompt(ev.toolCall),
      });
      const flipped = await tx
        .update(runs)
        .set({ status: "NeedsInput", currentStepId: pctx.stepId })
        .where(and(eq(runs.id, pctx.runId), eq(runs.status, "Running")))
        .returning({ projectId: runs.projectId });
      const projectRows =
        flipped.length > 0
          ? flipped
          : await tx
              .select({ projectId: runs.projectId })
              .from(runs)
              .where(eq(runs.id, pctx.runId));

      await emitWebhookEvent({
        db: tx,
        type: "hitl.requested",
        projectId: projectRows[0].projectId,
        runId: pctx.runId,
        data: { hitlRequestId, kind: "permission", nodeId: null },
      });

      if (flipped.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.needs_input",
          projectId: flipped[0].projectId,
          runId: pctx.runId,
          data: { reason: "permission", nodeId: null },
        });
      }
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
      await pctx.db.transaction(async (tx: DbClientLike) => {
        const rows = await tx
          .update(runs)
          .set({ status: "Crashed", endedAt: new Date() })
          .where(and(eq(runs.id, pctx.runId), eq(runs.status, "Running")))
          .returning({
            projectId: runs.projectId,
            taskId: runs.taskId,
            flowId: runs.flowId,
            runKind: runs.runKind,
          });

        if (rows.length > 0) {
          await emitWebhookEvent({
            db: tx,
            type: "run.crashed",
            projectId: rows[0].projectId,
            runId: pctx.runId,
            data: { errorCode: "CRASH" },
          });
          await emitDomainEvent({
            db: tx,
            kind: "run.crashed",
            projectId: rows[0].projectId,
            runId: pctx.runId,
            taskId: rows[0].taskId,
            actor: { type: "system", id: null },
            payload: {
              runId: pctx.runId,
              taskId: rows[0].taskId,
              flowId: rows[0].flowId,
              runKind: rows[0].runKind,
              reason: "CRASH",
            },
          });
        }
      });
      await systemCloseActiveAssignmentsForRun({
        db: pctx.db,
        runId: pctx.runId,
        reason: "permission persistence failed before HITL wait became durable",
      });
    } catch (updateErr) {
      log.warn(
        {
          runId: pctx.runId,
          err:
            updateErr instanceof Error ? updateErr.message : String(updateErr),
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
  // M8 Codex review fix #1: true iff a `session.exited` event with
  // `reason: "checkpoint"` was observed on the SSE stream. The runner
  // uses this to suppress step success even when the adapter returned
  // `stopReason: "end_turn"` (which it will, because a cancelled-with-
  // reason permission is journaled-for-replay, not denied).
  checkpointReasonObserved: () => boolean;
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
  let checkpointObserved = false;
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
          if (ev.type === "session.exited" && ev.reason === "checkpoint") {
            checkpointObserved = true;
          }
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
    checkpointReasonObserved: () => checkpointObserved,
  };
}

// M30 (ADR-078/081 interplay): a resumed rework session may carry gate-chat
// turns whose L1 preamble said "read-only, do not modify the workspace" — the
// rework prompt must explicitly lift that, or the agent may refuse edits.
// Server-side constant, never user text, prepended AFTER template rendering.
const RESUME_READONLY_LIFT =
  "Note: any earlier read-only review-chat instructions no longer apply — " +
  "this is a rework turn and workspace edits are expected.\n\n";

export async function runAgentStep(
  step: AgentStepLike,
  ctx: RunAgentStepCtx,
  supervisorApi: SupervisorApi = defaultSupervisor,
): Promise<StepResult & { acpSessionId?: string; sessionFallback?: boolean }> {
  let promptTemplate = step.prompt;

  // M34 (ADR-089): a catalog-agent binding substitutes the inline prompt —
  // the agent's .md body becomes the system block and the node prompt is
  // appended as the task block (mode=session), or the definition is
  // materialized into .claude/agents/ for Claude self-delegation
  // (mode=subagent; the inline prompt stays the driver).
  if (ctx.agentBinding) {
    const { resolveFlowBoundAgent } = await import("@/lib/agents/flow-binding");
    const bound = await resolveFlowBoundAgent({
      agentId: ctx.agentBinding.id,
      runId: ctx.runId,
      executorAgent: ctx.executor.agent,
      worktreePath: ctx.worktreePath,
      db: ctx.db,
    });

    if (bound.mode === "session") {
      promptTemplate = `${bound.prompt}\n\n## Task\n\n${step.prompt}`;
    }
  }

  const rendered = renderStrict(
    promptTemplate,
    ctx.context as unknown as Record<string, unknown>,
    { traceLog: log },
  );
  const resolvedPrompt = ctx.resumeSessionId
    ? RESUME_READONLY_LIFT + rendered
    : rendered;

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
): Promise<StepResult & { acpSessionId?: string; sessionFallback?: boolean }> {
  const startedAt = Date.now();
  let session: CreateSessionResult | null = null;
  let consumer: EventConsumer | null = null;
  let sessionFallback = false;

  try {
    const createInput = {
      runId: ctx.runId,
      projectSlug: ctx.projectSlug,
      worktreePath: ctx.worktreePath,
      stepId: ctx.stepId,
      nodeAttemptId: ctx.nodeAttemptId,
      executor: executorToSupervisorInput(ctx.executor),
      runner: ctx.runner,
      capabilityProfilePath: ctx.capabilityProfilePath,
      adapterLaunch: ctx.adapterLaunch,
      mcpServers: ctx.mcpServers,
    };

    if (ctx.resumeSessionId) {
      // M30 (ADR-081): try the resume respawn first; a gone/unresumable
      // session degrades OBSERVABLY to a fresh one (session_fallback).
      try {
        session = await api.createSession({
          ...createInput,
          resumeSessionId: ctx.resumeSessionId,
        });
      } catch (err) {
        sessionFallback = true;
        log.warn(
          {
            runId: ctx.runId,
            stepId: ctx.stepId,
            resumeSessionId: ctx.resumeSessionId,
            err: (err as Error).message,
          },
          "[session-policy] resume failed — falling back to a new session",
        );
        session = await api.createSession(createInput);
      }
    } else {
      session = await api.createSession(createInput);
    }

    consumer = startEventConsumer(session.sessionId, api, {
      db: ctx.db ?? getDb(),
      runId: ctx.runId,
      stepId: ctx.stepId,
      supervisorSessionId: session.sessionId,
      cancelPermission: api.cancelPermission,
      deliverPermission: api.deliverPermission,
    });

    let promptResult: PromptResult;

    try {
      promptResult = await api.sendPrompt(session.sessionId, {
        stepId: ctx.stepId,
        nodeAttemptId: ctx.nodeAttemptId,
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
    //
    // M8 Codex review fix #1: checkpoint observation ALSO overrides
    // stopReason. A cancelled-with-reason permission causes the adapter
    // to return end_turn — but the step is paused (journaled for replay
    // on --resume), NOT successful. Surface STEP_CHECKPOINTED so runFlow
    // does not advance and does not write terminal Review.
    const persistFailure = consumer.permissionPersistFailure();
    const checkpointed = consumer.checkpointReasonObserved();

    if (checkpointed) {
      await markCheckpointedFromExit(ctx.runId, { db: ctx.db ?? getDb() });
      log.info(
        {
          runId: ctx.runId,
          stepId: ctx.stepId,
          stopReason: promptResult.stopReason,
          acpSessionId: session.acpSessionId,
        },
        "step paused by supervisor checkpoint — STEP_CHECKPOINTED",
      );

      return {
        ok: false,
        stdout: consumer.snapshot(),
        vars: {},
        durationMs: Date.now() - startedAt,
        errorCode: "STEP_CHECKPOINTED" as const,
        acpSessionId: session.acpSessionId,
        sessionFallback,
      };
    }

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
      sessionFallback,
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
      runner: ctx.runner,
      capabilityProfilePath: ctx.capabilityProfilePath,
      adapterLaunch: ctx.adapterLaunch,
      mcpServers: ctx.mcpServers,
    });

    ctx.sessionState.currentSessionId = session.sessionId;
    // First-MATERIALIZED pin: the session is bound to the first capability
    // profile digest it actually carries. A profile-LESS first node seeds this
    // `undefined`; the reuse branch below then ADOPTS the first reuse that
    // carries a digest (the `??=`), so the consistency guard tracks
    // first-materialized rather than first-seed. (Dormant today — the graph
    // runner forces new-session, so reuse is unreachable; M14 T4.5.)
    ctx.sessionState.profileDigest = ctx.profileDigest;
    log.info(
      {
        runId: ctx.runId,
        stepId: ctx.stepId,
        sessionId: session.sessionId,
        acpSessionId: session.acpSessionId,
      },
      "slash-in-existing primary session seeded",
    );
  } else {
    assertSessionProfileConsistent(
      ctx.sessionState.profileDigest,
      ctx.profileDigest,
    );
    // Adopt the first-materialized digest: once a permitted reuse arrives with a
    // defined digest on a session that was seeded profile-less, pin to it so a
    // LATER node with a different profile is rejected instead of comparing
    // against `undefined` and silently slipping through (M14 T4.5).
    ctx.sessionState.profileDigest ??= ctx.profileDigest;
  }

  const sessionId = ctx.sessionState.currentSessionId;
  const consumer = startEventConsumer(sessionId, api, {
    db: ctx.db ?? getDb(),
    runId: ctx.runId,
    stepId: ctx.stepId,
    supervisorSessionId: sessionId,
    cancelPermission: api.cancelPermission,
    deliverPermission: api.deliverPermission,
  });

  let promptResult: PromptResult;

  try {
    promptResult = await api.sendPrompt(sessionId, {
      stepId: ctx.stepId,
      nodeAttemptId: ctx.nodeAttemptId,
      prompt: resolvedPrompt,
    });
  } finally {
    consumer.abort.abort();
    await consumer.done;
  }

  // M8 Codex review fix #1: see runNewSession for rationale.
  const persistFailure = consumer.permissionPersistFailure();
  const checkpointed = consumer.checkpointReasonObserved();

  if (checkpointed) {
    await markCheckpointedFromExit(ctx.runId, { db: ctx.db ?? getDb() });
    log.info(
      {
        runId: ctx.runId,
        stepId: ctx.stepId,
        stopReason: promptResult.stopReason,
        sessionId,
      },
      "slash-in-existing step paused by supervisor checkpoint — STEP_CHECKPOINTED",
    );

    return {
      ok: false,
      stdout: consumer.snapshot(),
      vars: {},
      durationMs: Date.now() - startedAt,
      errorCode: "STEP_CHECKPOINTED" as const,
      acpSessionId: sessionId,
    };
  }

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
