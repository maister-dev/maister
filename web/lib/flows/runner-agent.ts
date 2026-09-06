import "server-only";

import type { CapabilityAgent } from "@/lib/config.schema";
import type { ScratchAdapterLaunch } from "@/lib/db/schema";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { SessionEnforcementProfile } from "./enforcement-profile";
import type { HooksConfig } from "./hooks-config";
import type { FlowContext, StepResult } from "./types";
import type { CreateSessionPayload } from "@/lib/execution-host/contracts";

import { randomUUID } from "node:crypto";

import { eq, and, isNull, isNotNull, sql } from "drizzle-orm";
import pino from "pino";

import { PERMISSION_RESUME_PROMPT } from "./graph/permission-resume";
import { renderStrict } from "./templating";
import {
  admitNodePrompt,
  nodePromptOperationKey,
  type NodePromptOwner,
} from "./graph/node-prompt-owner";
import {
  admitGatePrompt,
  flowPromptOwners,
  FlowPromptContinuationPending,
  gatePromptOperationKey,
  waitForGateApplication,
  waitForPromptIncarnation,
  type GatePromptOwner,
} from "./graph/prompt-owner";
import {
  assertFlowDriverClaim,
  assertFlowDriverCommit,
  FlowDriverClaimLost,
  isFlowDriverClaimLost,
  type FlowDriverClaim,
} from "./graph/driver-claim";
import { closeAppliedFlowPromptSession } from "./graph/prompt-session-cleanup";
import {
  handleFlowPermission,
  hasPendingFlowPermission,
  replayAdmittedFlowPermissionInputs,
  type FlowPermissionOwner,
} from "./graph/prompt-permission";

import { normalizeCapabilityTokens } from "@/lib/capabilities/token-normalizer";
import { appendCapped } from "@/lib/flows/capped-text";
import {
  completeHitlAssignmentFromCurrentActor,
  createHitlAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import {
  executionAssignments,
  executionCommands,
  hitlRequests,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { nextKeepaliveAt } from "@/lib/runs/keepalive-config";
import { markCheckpointedFromExit } from "@/lib/runs/state-transitions";
import {
  createExecutionHosts,
  isFencedError,
  publishCapabilityBundle,
  type BoundClient,
  type CreateSessionResult,
  type ExecutionHosts,
  type HostAdminClient,
  type HostSessionId,
  type PlacementReason,
  type PromptResult,
  type RuntimeObjectOutputBinding,
  type SupervisorEvent,
  type SupervisorExecutorInput,
  type SupervisorRunnerInput,
} from "@/lib/execution-host";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { escalateHookTrip } from "@/lib/runs/hook-trip";
import { haltRuleFromEvent } from "@/lib/runs/hook-trip-rule";
import { staleSessionBinding } from "@/lib/execution-host/session-binding";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { isMaisterError } from "@/lib/errors";
import { SessionCreatePending } from "@/lib/execution-host/owned-session-create";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

const log = pino({
  name: "flow-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-165: the accumulator itself lives in lib/flows/capped-text.ts, shared
// with the standalone-agent capture path. The cap value stays local — this is
// the flow-node path's historic 1 MiB, and the two paths are free to differ.
const STDOUT_CAP_BYTES = 1024 * 1024;

export type AgentStepLike = {
  id: string;
  type: "agent";
  mode: "new-session";
  prompt: string;
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
  promptOwner?: GatePromptOwner | NodePromptOwner;
  flowDriverClaim?: FlowDriverClaim;
  signal?: AbortSignal;
  worktreePath: string;
  // ADR-166: the caller's once-per-driver-generation binding, resolved lazily
  // at the first agent dispatch (so a mocked step never binds and a failed
  // binding surfaces as THIS step's failure, with its attempt in the ledger).
  bindExecution?: () => Promise<AgentExecution>;
  // M34 (ADR-089): the node's `settings.agent` catalog binding — resolved at
  // dispatch (session-mode prompt substitution / subagent materialization).
  agentBinding?: { id: string };
  // M39 (ADR-106): the run's DRIVING agent (a launch with flow_ref) — its `.md`
  // persona is injected on EVERY ai_coding node (augment-not-replace). A per-node
  // `agentBinding` wins for that node; otherwise this run-level persona applies.
  runPersonaAgentId?: string;
  executor: {
    id: string;
    agent: CapabilityAgent;
    model: string;
    env?: Record<string, string>;
  };
  runner?: SupervisorRunnerInput;
  // M42 (ADR-114): the logical Flow session this node runs in — forwarded to the
  // supervisor for per-session cost/event attribution.
  sessionName?: string;
  context: FlowContext;
  capabilityProfilePath?: string;
  capabilityInstructionsPath?: string;
  outputObjects?: RuntimeObjectOutputBinding[];
  adapterLaunch?: ScratchAdapterLaunch;
  mcpServers?: AgentMcpServer[];
  profileDigest?: string;
  // M30 (ADR-081): rework `resume` — respawn the adapter and restore the
  // prior attempt's conversation via the ACP session/resume protocol call.
  // Unresumable → fall back to a fresh session and flag sessionFallback.
  resumeSessionId?: string;
  // B1 (execution-policy permissions=auto_approve): resolved from the run's
  // execution_policy snapshot in runGraph; threaded to the supervisor session
  // so the requestPermission handler auto-approves inline (L3).
  autoApprovePermissions?: boolean;
  // ADR-108 (M40): resolved guardrail rule set (resolveHooksConfig in runGraph),
  // threaded onto the supervisor session body so the hook interceptor arms.
  hooksConfig?: HooksConfig;
  // ADR-130: derived capability-enforcement set (deriveSessionEnforcementProfile in
  // runGraph), threaded onto the session body so the capability_guard interceptor arms.
  enforcementProfile?: SessionEnforcementProfile;
  db?: DbClientLike;
};

// ADR-166 D3/E-EH-11: the driver's execution seam — a client BOUND to the
// run's active assignment (every host-bound command carries that epoch, so a
// superseded driver is fenced by the host, never silently re-bound) plus the
// host-scoped admin reads (the per-session event stream). Bound ONCE per
// driver generation by the graph runner; tests inject a fake-backed pair.
export type AgentExecution = {
  client: BoundClient;
  admin: HostAdminClient;
};

export async function bindExecution(
  hosts: ExecutionHosts,
  runId: string,
  opts: { assignmentId?: string | null; reason?: PlacementReason } = {},
): Promise<AgentExecution> {
  return hosts.executionFor(runId, opts);
}

async function assignmentIsCurrent(
  db: DbClientLike,
  execution: AgentExecution,
): Promise<boolean> {
  const rows = await db
    .select({ state: executionAssignments.state })
    .from(executionAssignments)
    .where(eq(executionAssignments.id, execution.client.assignment.id))
    .limit(1);

  return rows[0]?.state === "active";
}

type PermissionDeliverer = (
  sessionId: string,
  requestId: string,
  optionId: string,
) => Promise<{ ok: true }>;

type PermissionCanceller = (
  sessionId: string,
  requestId: string,
  reason: string,
) => Promise<{ ok: true }>;

function permissionDelivererFor(client: BoundClient): PermissionDeliverer {
  return (sessionId, requestId, optionId) =>
    client.deliverInput(sessionId, {
      kind: "permission",
      action: "select",
      requestId,
      optionId,
    });
}

function permissionCancellerFor(client: BoundClient): PermissionCanceller {
  return (sessionId, requestId, reason) =>
    client.deliverInput(sessionId, {
      kind: "permission",
      action: "cancel",
      requestId,
      reason: reason.slice(0, 256),
    });
}

function synthesizePermissionPrompt(toolCall: unknown): string {
  const tc = (toolCall ?? {}) as { title?: string };

  return tc.title ? `Approve ${tc.title}?` : "Approve tool call?";
}

type PermissionContext = {
  db: DbClientLike;
  runId: string;
  stepId: string;
  // The HOST session id (the supervisor's URL key) — never the ACP resume
  // handle. It is what the permission HITL row stores and replays against.
  supervisorSessionId: string;
  cancelPermission: PermissionCanceller;
  deliverPermission: PermissionDeliverer;
  ownedPrompt?: { owner: FlowPermissionOwner; client: BoundClient };
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
  if (pctx.ownedPrompt) {
    await handleFlowPermission({
      db: pctx.db,
      client: pctx.ownedPrompt.client,
      owner: pctx.ownedPrompt.owner,
      hostSessionId: pctx.supervisorSessionId,
      stepId: pctx.stepId,
      event: ev,
      prompt: synthesizePermissionPrompt(ev.toolCall),
    });

    return { ok: true };
  }
  const auto = await tryAutoDeliverStoredIntent(ev, pctx);

  if (auto.delivered) {
    return { ok: true } as const;
  }

  const hitlRequestId = randomUUID();
  const permissionSchema = {
    requestId: ev.requestId,
    options: ev.options,
    toolCall: ev.toolCall,
    supervisorSessionId: pctx.supervisorSessionId,
  };
  const prompt = synthesizePermissionPrompt(ev.toolCall);
  let persistedHitlId = hitlRequestId;
  let reused = false;

  try {
    await pctx.db.transaction(async (tx: DbClientLike) => {
      // Dedup on re-emit (resume/reconnect): if an UNDECIDED (response IS NULL)
      // open permission row already exists for this (run, step), refresh it in
      // place instead of inserting a duplicate. Without this, every keep-alive
      // checkpoint→resume cycle stacks another inbox card onto the same blocked
      // step. The decided-but-undelivered case is handled by
      // tryAutoDeliverStoredIntent above; here we own the still-open case.
      const priorOpen = await tx
        .select({ id: hitlRequests.id })
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.runId, pctx.runId),
            eq(hitlRequests.stepId, pctx.stepId),
            eq(hitlRequests.kind, "permission"),
            isNull(hitlRequests.respondedAt),
            isNull(hitlRequests.response),
          ),
        )
        .limit(1);

      reused = priorOpen[0] !== undefined;
      persistedHitlId = priorOpen[0]?.id ?? hitlRequestId;

      if (reused) {
        await tx
          .update(hitlRequests)
          .set({ schema: permissionSchema, prompt })
          .where(eq(hitlRequests.id, persistedHitlId));
      } else {
        await tx.insert(hitlRequests).values({
          id: hitlRequestId,
          runId: pctx.runId,
          stepId: pctx.stepId,
          kind: "permission",
          schema: permissionSchema,
          prompt,
        });
        await createHitlAssignmentForRun({
          db: tx,
          runId: pctx.runId,
          hitlRequestId,
          stepId: pctx.stepId,
          actionKind: "permission",
          roleRefs: [],
          title: prompt,
        });
      }

      const flipped = await tx
        .update(runs)
        // Arm the keep-alive idle window on the Running→NeedsInput flip (the
        // status guard means this fires only on a genuine block, not a re-emit
        // while already NeedsInput). Without it keepalive_until stays null, the
        // sweeper never idles the run, and the agent runs forever re-emitting.
        // Mirrors the agent-run path (lib/agents/launch.ts).
        .set({
          status: "NeedsInput",
          currentStepId: pctx.stepId,
          keepaliveUntil: nextKeepaliveAt(),
        })
        .where(and(eq(runs.id, pctx.runId), eq(runs.status, "Running")))
        .returning({ projectId: runs.projectId });
      const projectRows =
        flipped.length > 0
          ? flipped
          : await tx
              .select({ projectId: runs.projectId })
              .from(runs)
              .where(eq(runs.id, pctx.runId));

      // A brand-new request announces itself; a reused row is the same request
      // re-blocking, so only the run.needs_input transition (below) fires.
      if (!reused) {
        await emitWebhookEvent({
          db: tx,
          type: "hitl.requested",
          projectId: projectRows[0].projectId,
          runId: pctx.runId,
          data: { hitlRequestId, kind: "permission", nodeId: null },
        });
      }

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
        hitlRequestId: persistedHitlId,
        reused,
        requestId: ev.requestId,
        supervisorSessionId: pctx.supervisorSessionId,
      },
      reused
        ? "permission_request re-emit reused open row; run kept at NeedsInput"
        : "permission_request persisted; run transitioned to NeedsInput",
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
            parentRunId: runs.parentRunId,
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
            parentRunId: rows[0].parentRunId,
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

// The agent produced output after a permission request. That means the
// permission was ANSWERED only when its HITL row carries a response — a
// keep-alive/park checkpoint cancels the deferred with a reason instead, and
// the adapter still emits an update ("permission outcome: cancelled") on the
// way out. Flipping on that update would race the NeedsInput-guarded
// checkpoint transitions and strand the run `Running`. The response is stored
// in the respond route's Phase-1 transaction, BEFORE the wire delivery, so an
// update that beats the acknowledgement still sees it; a miss is retried on the
// next update. Returns whether the run was flipped.
async function transitionBackToRunning(
  db: DbClientLike,
  runId: string,
  requestId: string,
): Promise<boolean> {
  try {
    const answered = (
      (await db
        .select({ id: hitlRequests.id, response: hitlRequests.response })
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.runId, runId),
            eq(hitlRequests.kind, "permission"),
            sql`${hitlRequests.schema}->>'requestId' = ${requestId}`,
            isNotNull(hitlRequests.response),
          ),
        )
        .limit(1)) as Array<{ id: string; response: unknown }>
    ).some((row) => row.response !== null && row.response !== undefined);

    if (!answered) return false;

    await db
      .update(runs)
      .set({ status: "Running" })
      .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")));

    return true;
  } catch (err) {
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "NeedsInput→Running update failed",
    );

    return false;
  }
}

type EventConsumer = {
  abort: AbortController;
  failureSignal: AbortSignal;
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
  // Resolves true as soon as the checkpoint exit reason is observed, or false
  // after `waitMs` (a prompt failure racing our own checkpoint teardown).
  checkpointObserved: (waitMs: number) => Promise<boolean>;
  // ADR-108 (M40): true iff a halting guardrail trip was escalated for this
  // session. escalateHookTrip already CAS'd Running→NeedsInput + opened the
  // hook_trip HITL, so the runner MUST surface STEP_CHECKPOINTED WITHOUT
  // markCheckpointedFromExit (which would flip NeedsInput→NeedsInputIdle and
  // break the runFlow NeedsInput resume).
  hookTripEscalated: () => boolean;
  // ADR-108 (M40): true iff escalateHookTrip REJECTED — the pre-tx checkpoint
  // returned EXECUTOR_UNAVAILABLE (live halt, undeliverable) or its tx threw. The
  // run is stranded Running with no hook_trip HITL, so the runner MUST surface
  // CRASH (not a clean STEP_CHECKPOINTED) — runFlow marks it Crashed and
  // crash-reconcile/recover can session/resume the retained acpSessionId.
  hookTripEscalateFailed: () => boolean;
};

function executorToSupervisorInput(
  exec: RunAgentStepCtx["executor"],
): SupervisorExecutorInput {
  return {
    agent: exec.agent,
    model: exec.model,
    env: exec.env,
  };
}

function startEventConsumer(
  sessionId: string,
  execution: AgentExecution,
  permissionCtx?: PermissionContext,
): EventConsumer {
  const abort = new AbortController();
  const failure = new AbortController();
  let buf = "";
  let pendingPermissionRequestId: string | null = null;
  let persistFailure: { reason: string } | null = null;
  let checkpointObserved = false;
  let streamEnded = false;
  const checkpointWaiters: Array<() => void> = [];
  let hookEscalated = false;
  let hookEscalateFailed = false;
  const pendingWork: Promise<void>[] = [];

  const done = (async () => {
    try {
      for await (const ev of execution.admin.streamSession(sessionId, {
        signal: abort.signal,
      })) {
        // ADR-108 (M40): a halting guardrail trip (repetition / no_progress)
        // checkpoints + escalates to NeedsInput; a path_guard deny is
        // record-only (the supervisor already denied inline, deny-and-continue).
        // Claim once — the supervisor halts a session a single time.
        if (ev.type === "session.hook_trip" && permissionCtx) {
          if (ev.disposition === "halt" && !hookEscalated) {
            hookEscalated = true;
            // ADR-130: capability_guard also halts (Nth deny) — carry the real rule
            // (not mislabeled repetition) via the single exhaustive mapper.
            const haltRule = haltRuleFromEvent(ev.rule);

            pendingWork.push(
              escalateHookTrip({
                db: permissionCtx.db,
                runId: permissionCtx.runId,
                stepId: permissionCtx.stepId,
                supervisorSessionId: permissionCtx.supervisorSessionId,
                rule: haltRule,
                toolCall: ev.toolCall,
                runKind: "flow",
                checkpointSession: (id) => execution.client.checkpoint(id),
              }).then(
                (r) => {
                  // Benign no-escalate (run gone / not Running / lost CAS) →
                  // un-claim so the runner does not suppress the normal
                  // checkpoint/exit handling. (EXECUTOR_UNAVAILABLE now rejects.)
                  if (!r.escalated) hookEscalated = false;
                },
                (err: unknown) => {
                  // escalateHookTrip rejected: either the pre-tx checkpoint
                  // returned EXECUTOR_UNAVAILABLE (the halt is live but
                  // undeliverable) or its tx threw. Either way the run is stranded
                  // Running with no hook_trip HITL. Un-claim and flag the failure
                  // so the runner surfaces CRASH instead of a clean checkpoint —
                  // without this, Promise.allSettled swallows the rejection and
                  // hookEscalated stays true (false STEP_CHECKPOINTED on a
                  // stranded run).
                  hookEscalated = false;
                  hookEscalateFailed = true;
                  log.error(
                    {
                      runId: permissionCtx.runId,
                      err: err instanceof Error ? err.message : String(err),
                    },
                    "hook_trip escalation threw — surfacing CRASH",
                  );
                },
              ),
            );
          } else if (ev.disposition === "deny") {
            log.debug(
              { runId: permissionCtx.runId, rule: ev.rule },
              "path_guard deny — run continues (record-only)",
            );
          }
        }
        if (ev.type === "session.permission_request" && permissionCtx) {
          pendingPermissionRequestId = ev.requestId;
          pendingWork.push(
            handlePermissionRequest(ev, permissionCtx).then(
              (outcome) => {
                if (!outcome.ok && !persistFailure) {
                  persistFailure = { reason: outcome.reason };
                }
              },
              (error: unknown) => {
                persistFailure = {
                  reason: isMaisterError(error)
                    ? error.code
                    : "permission_handler_failed",
                };
                log.error(
                  {
                    runId: permissionCtx.runId,
                    requestId: ev.requestId,
                    reason: persistFailure.reason,
                  },
                  "owned-permission-handler-failed",
                );
                failure.abort(error);
              },
            ),
          );
        }
        if (ev.type === "session.update") {
          if (
            pendingPermissionRequestId &&
            permissionCtx &&
            !permissionCtx.ownedPrompt
          ) {
            const requestId = pendingPermissionRequestId;

            pendingWork.push(
              transitionBackToRunning(
                permissionCtx.db,
                permissionCtx.runId,
                requestId,
              ).then((flipped) => {
                if (flipped && pendingPermissionRequestId === requestId) {
                  pendingPermissionRequestId = null;
                }
              }),
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
            buf = appendCapped(buf, update.content.text, STDOUT_CAP_BYTES);
          }
        }
        if (ev.type === "session.line") {
          // Defensive: legacy raw-line events may carry text we still want to capture.
          const line = (
            ev as Extract<SupervisorEvent, { type: "session.line" }>
          ).line;

          buf = appendCapped(buf, line + "\n", STDOUT_CAP_BYTES);
        }
        if (ev.type === "session.exited" || ev.type === "session.crashed") {
          if (ev.type === "session.exited" && ev.reason === "checkpoint") {
            checkpointObserved = true;
            for (const wake of checkpointWaiters.splice(0)) wake();
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
      streamEnded = true;
      for (const wake of checkpointWaiters.splice(0)) wake();
    }
  })();

  return {
    abort,
    failureSignal: failure.signal,
    done,
    snapshot: () => buf,
    reset: () => {
      buf = "";
    },
    permissionPersistFailure: () => persistFailure,
    checkpointReasonObserved: () => checkpointObserved,
    // Settles as soon as the checkpoint reason lands OR the stream ends (a
    // crash / clean exit is a definitive "not a checkpoint") — never sits out
    // the full grace period behind a consumer that already finished.
    checkpointObserved: (waitMs) =>
      checkpointObserved || streamEnded
        ? Promise.resolve(checkpointObserved)
        : new Promise<boolean>((resolve) => {
            const settle = () => {
              clearTimeout(timer);
              resolve(checkpointObserved);
            };
            const timer = setTimeout(settle, waitMs);

            timer.unref?.();
            checkpointWaiters.push(settle);
          }),
    hookTripEscalated: () => hookEscalated,
    hookTripEscalateFailed: () => hookEscalateFailed,
  };
}

// M30 (ADR-078/081 interplay): a resumed rework session may carry gate-chat
// turns whose L1 preamble said "read-only, do not modify the workspace" — the
// rework prompt must explicitly lift that, or the agent may refuse edits.
// Server-side constant, never user text, prepended AFTER template rendering.
const RESUME_READONLY_LIFT =
  "Note: any earlier read-only review-chat instructions no longer apply — " +
  "this is a rework turn and workspace edits are expected.\n\n";

async function findOwnedPrompt(
  db: Db,
  runId: string,
  key: string,
): Promise<ExecutionCommand | null> {
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.prompt"),
        eq(executionCommands.logicalOperationKey, key),
      ),
    )
    .limit(1);

  return command ?? null;
}

async function waitForNodeApplication(
  db: Db,
  client: BoundClient,
  commandId: string,
  owner: NodePromptOwner,
  signal?: AbortSignal,
): Promise<StepResult> {
  let waitError: unknown;

  try {
    try {
      await client.waitForPrompt(
        { commandId },
        { owners: flowPromptOwners, signal },
      );
    } catch (error) {
      waitError = error;
    }
    const [row] = await db
      .select({ attempt: nodeAttempts, run: runs, command: executionCommands })
      .from(nodeAttempts)
      .innerJoin(runs, eq(runs.id, nodeAttempts.runId))
      .innerJoin(executionCommands, eq(executionCommands.id, commandId))
      .where(eq(nodeAttempts.id, owner.nodeAttemptId));
    const completion = row?.attempt.actionCompletion;

    if (
      !row ||
      !completion ||
      completion.commandId !== commandId ||
      completion.promptOrdinal !== owner.promptOrdinal ||
      row.command.applicationState !== "applied" ||
      row.command.runId !== row.run.id ||
      row.command.executionAssignmentId !== client.assignment.id ||
      row.run.status !== "Running" ||
      row.run.currentStepId !== row.attempt.nodeId ||
      row.run.executionAssignmentId !== client.assignment.id ||
      row.attempt.executionAssignmentId !== client.assignment.id
    )
      throw new FlowPromptContinuationPending(
        commandId,
        waitError ??
          new PromptOwnerInvariantError("node_action_completion_pending"),
      );

    return {
      ...completion.result,
      originalOutput: completion.originalOutput,
      durationMs: 0,
    };
  } catch (error) {
    if (error instanceof FlowPromptContinuationPending) throw error;
    throw new FlowPromptContinuationPending(commandId, error);
  }
}

async function replayPermissionInputsForContinuation(
  db: Db,
  client: BoundClient,
  commandId: string,
): Promise<void> {
  log.debug(
    { runId: client.assignment.runId, commandId },
    "owned-permission-input-replay",
  );
  try {
    await replayAdmittedFlowPermissionInputs(db, client, commandId);
  } catch (cause) {
    throw new FlowPromptContinuationPending(commandId, cause);
  }
}

async function reattachNodePrompt(
  ctx: RunAgentStepCtx,
  owner: NodePromptOwner,
  execution?: AgentExecution,
): Promise<StepResult | null> {
  const db = ctx.db ?? getDb();
  const existing = await findOwnedPrompt(
    db,
    ctx.runId,
    nodePromptOperationKey(owner),
  );

  if (!existing) return null;
  const bound =
    execution ??
    (ctx.bindExecution
      ? await ctx.bindExecution()
      : await bindExecution(createExecutionHosts({ db }), ctx.runId));

  if (existing.executionAssignmentId !== bound.client.assignment.id)
    throw staleSessionBinding(ctx.runId, existing.executionAssignmentId);
  if (!existing.targetSessionId)
    throw new PromptOwnerInvariantError("node_permission_session_missing");
  await replayPermissionInputsForContinuation(db, bound.client, existing.id);
  const consumer = startEventConsumer(existing.targetSessionId, bound, {
    db,
    runId: ctx.runId,
    stepId: ctx.stepId,
    supervisorSessionId: existing.targetSessionId,
    cancelPermission: permissionCancellerFor(bound.client),
    deliverPermission: permissionDelivererFor(bound.client),
    ownedPrompt: { owner, client: bound.client },
  });
  let result: StepResult;

  try {
    result = await waitForNodeApplication(
      db,
      bound.client,
      existing.id,
      owner,
      AbortSignal.any([
        consumer.failureSignal,
        ...(ctx.signal ? [ctx.signal] : []),
      ]),
    );
  } finally {
    consumer.abort.abort();
    await consumer.done;
  }
  if (consumer.permissionPersistFailure())
    throw new FlowPromptContinuationPending(
      existing.id,
      new PromptOwnerInvariantError("node_permission_pending"),
    );

  await closeAppliedFlowPromptSession(db, bound.client, existing.id);

  return result;
}

async function assertGatePermissionSettled(
  db: Db,
  runId: string,
  commandId: string,
): Promise<void> {
  const [run] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));
  const pending = await hasPendingFlowPermission(db, runId, commandId);

  if (run?.status !== "Running" || pending)
    throw new FlowPromptContinuationPending(
      commandId,
      new PromptOwnerInvariantError("gate_permission_pending"),
    );
}

export async function reattachGatePrompt(
  ctx: Pick<
    RunAgentStepCtx,
    "db" | "runId" | "stepId" | "bindExecution" | "signal"
  >,
  owner: GatePromptOwner,
  execution?: AgentExecution,
): Promise<StepResult | null> {
  const db = ctx.db ?? getDb();
  const existing = await findOwnedPrompt(
    db,
    ctx.runId,
    gatePromptOperationKey(owner),
  );

  if (!existing) return null;
  const bound =
    execution ??
    (ctx.bindExecution
      ? await ctx.bindExecution()
      : await bindExecution(createExecutionHosts({ db }), ctx.runId));

  if (existing.executionAssignmentId !== bound.client.assignment.id)
    throw staleSessionBinding(ctx.runId, existing.executionAssignmentId);
  if (!existing.targetSessionId)
    throw new PromptOwnerInvariantError("gate_permission_session_missing");
  await replayPermissionInputsForContinuation(db, bound.client, existing.id);
  const consumer = startEventConsumer(existing.targetSessionId, bound, {
    db,
    runId: ctx.runId,
    stepId: ctx.stepId,
    supervisorSessionId: existing.targetSessionId,
    cancelPermission: permissionCancellerFor(bound.client),
    deliverPermission: permissionDelivererFor(bound.client),
    ownedPrompt: { owner, client: bound.client },
  });

  try {
    await waitForGateApplication(
      db,
      bound.client,
      existing.id,
      AbortSignal.any([
        consumer.failureSignal,
        ...(ctx.signal ? [ctx.signal] : []),
      ]),
    );
  } finally {
    consumer.abort.abort();
    await consumer.done;
  }
  if (consumer.permissionPersistFailure())
    throw new FlowPromptContinuationPending(
      existing.id,
      new PromptOwnerInvariantError("gate_permission_pending"),
    );
  await assertGatePermissionSettled(db, ctx.runId, existing.id);
  await closeAppliedFlowPromptSession(db, bound.client, existing.id);
  log.info(
    {
      runId: ctx.runId,
      nodeAttemptId: owner.nodeAttemptId,
      evaluationId: owner.evaluationId,
      commandId: existing.id,
    },
    "gate-prompt-reattached",
  );

  return { ok: true, stdout: "", vars: {}, durationMs: 0 };
}

export async function runAgentStep(
  step: AgentStepLike,
  ctx: RunAgentStepCtx,
  execution?: AgentExecution,
): Promise<
  StepResult & {
    acpSessionId?: string;
    sessionFallback?: boolean;
  }
> {
  // Existing immutable requests do not depend on today's template or context.
  if (ctx.promptOwner) {
    const completed =
      ctx.promptOwner.variant === "node" ||
      ctx.promptOwner.variant === "permission_resume"
        ? await reattachNodePrompt(ctx, ctx.promptOwner, execution)
        : await reattachGatePrompt(ctx, ctx.promptOwner, execution);

    if (completed) return completed;
  }
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
  } else if (ctx.runPersonaAgentId) {
    // M39 (ADR-106): the run's DRIVING agent (a launch with flow_ref) augments
    // EVERY ai_coding node — its `.md` body is the persona/system block, the
    // node keeps its own task prompt (order persona-then-task). The driving
    // agent is launched by its own trigger and need not declare the "flow"
    // trigger, so that check is skipped; launch validates mode=session.
    const { resolveFlowBoundAgent } = await import("@/lib/agents/flow-binding");
    const bound = await resolveFlowBoundAgent({
      agentId: ctx.runPersonaAgentId,
      runId: ctx.runId,
      executorAgent: ctx.executor.agent,
      worktreePath: ctx.worktreePath,
      db: ctx.db,
      requireFlowTrigger: false,
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
  // Cross-runner capability-token normalization is web-side only (FR-E2); the
  // supervisor still forwards the assembled prompt verbatim. A capability the
  // resolved runner cannot honor → WARN + proceed (FR-E5), never a hard fail.
  const normalized = normalizeCapabilityTokens(rendered, ctx.executor.agent);

  if (normalized.warnings.length > 0) {
    log.warn(
      {
        runId: ctx.runId,
        stepId: ctx.stepId,
        agent: ctx.executor.agent,
        warnings: normalized.warnings,
      },
      "[capability-tokens] referenced capability not available on runner — proceeding",
    );
  }

  const actionPrompt =
    ctx.promptOwner?.variant === "permission_resume" ||
    ((ctx.promptOwner?.variant === "gate_ai" ||
      ctx.promptOwner?.variant === "gate_skill") &&
      ctx.promptOwner.promptOrdinal > 0)
      ? PERMISSION_RESUME_PROMPT
      : normalized.text;
  const resolvedPrompt = ctx.resumeSessionId
    ? RESUME_READONLY_LIFT + actionPrompt
    : actionPrompt;

  log.info(
    {
      runId: ctx.runId,
      stepId: ctx.stepId,
      mode: step.mode,
      promptLen: resolvedPrompt.length,
    },
    "agent step start",
  );

  // Capture the resolved prompt for this attempt before dispatch so it stays
  // visible even if the step later crashes or stalls. Best-effort: audit data,
  // a failed write must never block dispatch.
  if (
    ctx.nodeAttemptId &&
    (!ctx.promptOwner ||
      ctx.promptOwner.variant === "node" ||
      ctx.promptOwner.variant === "permission_resume")
  ) {
    try {
      // Write-once per attempt: a NeedsInput resume can re-enter the node with
      // the same nodeAttemptId; preserve the first dispatch's prompt instead of
      // overwriting it with a resume-lifted variant.
      const landed = await (ctx.db ?? getDb())
        .update(nodeAttempts)
        .set({ resolvedPrompt })
        .where(
          and(
            eq(nodeAttempts.id, ctx.nodeAttemptId),
            isNull(nodeAttempts.resolvedPrompt),
          ),
        )
        .returning({ id: nodeAttempts.id });

      log.debug(
        {
          runId: ctx.runId,
          nodeAttemptId: ctx.nodeAttemptId,
          promptLen: resolvedPrompt.length,
          landed: landed.length > 0,
        },
        "resolved_prompt persist",
      );
    } catch (err) {
      log.warn(
        {
          runId: ctx.runId,
          nodeAttemptId: ctx.nodeAttemptId,
          err: (err as Error).message,
        },
        "[runner-agent] resolved_prompt persist failed",
      );
    }
  }

  // A caller without a bound seam (standalone gate/consensus dispatch outside
  // the graph runner) binds to the run's ACTIVE assignment on its own db.
  const bound =
    execution ??
    (ctx.bindExecution
      ? await ctx.bindExecution()
      : await bindExecution(
          createExecutionHosts({ db: ctx.db ?? getDb() }),
          ctx.runId,
        ));

  return runNewSession(step, ctx, bound, resolvedPrompt);
}

async function runNewSession(
  _step: AgentStepLike,
  ctx: RunAgentStepCtx,
  execution: AgentExecution,
  resolvedPrompt: string,
): Promise<
  StepResult & {
    acpSessionId?: string;
    sessionFallback?: boolean;
  }
> {
  const startedAt = Date.now();
  const { client } = execution;
  let session: (CreateSessionResult & { hostSessionId: HostSessionId }) | null =
    null;
  let consumer: EventConsumer | null = null;
  let sessionFallback = false;
  let fenced = false;
  let continuationPending = false;
  let nodeCompletion: StepResult | null = null;

  try {
    const prepareCreatePayload = async (): Promise<
      Omit<CreateSessionPayload, "executionWorkspaceId">
    > => {
      const capabilityBundle =
        ctx.capabilityProfilePath && ctx.capabilityInstructionsPath
          ? await publishCapabilityBundle({
              client,
              runId: ctx.runId,
              sourceId: ctx.nodeAttemptId ?? ctx.stepId,
              profileLogicalName: `${ctx.stepId}-capability-profile.json`,
              profilePath: ctx.capabilityProfilePath,
              instructionsLogicalName: `${ctx.stepId}-capability-instructions.md`,
              instructionsPath: ctx.capabilityInstructionsPath,
            })
          : undefined;

      // ADR-166 D7: the handle form — the worktree, repo root, and context
      // mounts are adopted ONCE per assignment (`runs.context_mounts` rides the
      // adopt payload); the session body carries no path.
      return {
        stepId: ctx.stepId,
        nodeAttemptId: ctx.nodeAttemptId,
        sessionName: ctx.sessionName,
        executor: executorToSupervisorInput(ctx.executor),
        runner: ctx.runner,
        capabilityProfileObjectId: capabilityBundle?.profileObjectId,
        capabilityInstructionsObjectId: capabilityBundle?.instructionsObjectId,
        outputObjects: ctx.outputObjects,
        adapterLaunch: ctx.adapterLaunch,
        mcpServers: ctx.mcpServers,
        autoApprovePermissions: ctx.autoApprovePermissions,
        hooksConfig: ctx.hooksConfig,
        enforcementProfile: ctx.enforcementProfile,
      };
    };

    if (ctx.promptOwner) {
      const created = await client.createOwnedSession(
        ctx.promptOwner.variant === "permission_resume"
          ? {
              variant: "node",
              nodeAttemptId: ctx.promptOwner.nodeAttemptId,
              promptOrdinal: ctx.promptOwner.promptOrdinal,
            }
          : ctx.promptOwner.variant === "node"
            ? ctx.promptOwner
            : {
                variant: ctx.promptOwner.variant,
                nodeAttemptId: ctx.promptOwner.nodeAttemptId,
                gateId: ctx.promptOwner.gateId,
                evaluationId: ctx.promptOwner.evaluationId,
              },
        async () => ({
          ...(await prepareCreatePayload()),
          ...(ctx.resumeSessionId
            ? { resumeSessionId: ctx.resumeSessionId }
            : {}),
        }),
        {
          assertCommit: async (tx) => {
            if (!ctx.flowDriverClaim) return;
            if (ctx.signal?.aborted)
              throw new FlowDriverClaimLost(ctx.flowDriverClaim);
            await assertFlowDriverClaim(tx, ctx.flowDriverClaim);
          },
        },
      );

      session = created;
      sessionFallback = created.sessionFallback;
    } else {
      const createInput = await prepareCreatePayload();

      if (ctx.resumeSessionId) {
        // M30 (ADR-081): try the resume respawn first; a gone/unresumable
        // session degrades OBSERVABLY to a fresh one (session_fallback).
        try {
          session = await client.createSession({
            ...createInput,
            resumeSessionId: ctx.resumeSessionId,
          });
        } catch (err) {
          if (
            isFencedError(err) ||
            !isMaisterError(err) ||
            err.code !== "CHECKPOINT"
          )
            throw err;
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
          session = await client.createSession(createInput);
        }
      } else {
        session = await client.createSession(createInput);
      }
    }

    consumer = startEventConsumer(session.hostSessionId, execution, {
      db: ctx.db ?? getDb(),
      runId: ctx.runId,
      stepId: ctx.stepId,
      supervisorSessionId: session.hostSessionId,
      cancelPermission: permissionCancellerFor(client),
      deliverPermission: permissionDelivererFor(client),
      ...(ctx.promptOwner
        ? { ownedPrompt: { owner: ctx.promptOwner, client } }
        : {}),
    });

    let promptResult: PromptResult;

    try {
      const hostSessionId = session.hostSessionId;
      const promptOwner = ctx.promptOwner;

      if (promptOwner)
        await waitForPromptIncarnation(
          ctx.db ?? getDb(),
          client,
          hostSessionId,
        );
      const handle = await client.prompt(
        hostSessionId,
        {
          stepId: ctx.stepId,
          nodeAttemptId: ctx.nodeAttemptId,
          prompt: resolvedPrompt,
        },
        promptOwner
          ? {
              admitOwner: async (tx) => {
                if (ctx.flowDriverClaim) {
                  if (ctx.signal?.aborted)
                    throw new FlowDriverClaimLost(ctx.flowDriverClaim);
                  await assertFlowDriverClaim(tx, ctx.flowDriverClaim);
                }
                const admission =
                  promptOwner.variant === "node" ||
                  promptOwner.variant === "permission_resume"
                    ? await admitNodePrompt(
                        tx,
                        client,
                        hostSessionId,
                        promptOwner,
                      )
                    : await admitGatePrompt(
                        tx,
                        client,
                        hostSessionId,
                        promptOwner,
                      );
                const claim = ctx.flowDriverClaim;

                return {
                  ...admission,
                  ...(claim
                    ? {
                        assertCommit: async () => {
                          if (ctx.signal?.aborted)
                            throw new FlowDriverClaimLost(claim);
                          await assertFlowDriverCommit(tx, claim);
                        },
                      }
                    : {}),
                };
              },
            }
          : undefined,
      );

      try {
        if (
          promptOwner?.variant === "node" ||
          promptOwner?.variant === "permission_resume"
        ) {
          nodeCompletion = await waitForNodeApplication(
            ctx.db ?? getDb(),
            client,
            handle.commandId,
            promptOwner,
            AbortSignal.any([
              consumer.failureSignal,
              ...(ctx.signal ? [ctx.signal] : []),
            ]),
          );
          if (consumer.failureSignal.aborted)
            throw new FlowPromptContinuationPending(
              handle.commandId,
              consumer.failureSignal.reason,
            );
          promptResult = { stopReason: "end_turn", meta: null };
        } else if (promptOwner) {
          await waitForGateApplication(
            ctx.db ?? getDb(),
            client,
            handle.commandId,
            AbortSignal.any([
              consumer.failureSignal,
              ...(ctx.signal ? [ctx.signal] : []),
            ]),
          );
          await assertGatePermissionSettled(
            ctx.db ?? getDb(),
            ctx.runId,
            handle.commandId,
          );
          // The gate caller reads the applied verdict, including host failure.
          promptResult = { stopReason: "end_turn", meta: null };
        } else {
          promptResult = await client.waitForPrompt(handle);
        }
      } catch (err) {
        if (err instanceof FlowPromptContinuationPending) throw err;
        // A checkpoint (keep-alive sweep, budget park, node interrupt) tears
        // the adapter down mid-turn; the host then answers the in-flight turn
        // with a failure ("ACP connection closed") that is NOT the step's — the
        // consumer sees `session.exited{reason:"checkpoint"}` on the stream.
        // Give that signal a moment to land, then treat the turn as paused.
        if (await assignmentIsCurrent(ctx.db ?? getDb(), execution)) {
          if (
            isFencedError(err) ||
            !(await consumer.checkpointObserved(10_000))
          ) {
            throw err;
          }
        }
        log.info(
          {
            runId: ctx.runId,
            stepId: ctx.stepId,
            err: err instanceof Error ? err.message : String(err),
          },
          "prompt ended by our own checkpoint — treating the turn as paused",
        );
        promptResult = { stopReason: "cancelled", meta: null };
      }
    } finally {
      consumer.abort.abort();
      await consumer.done;
    }

    // A checkpoint command may commit and release this assignment before its
    // terminal host event reaches the canonical stream. That event is then
    // correctly retained as stale and cannot drive projections, so the old
    // session consumer cannot rely on seeing `session.exited{checkpoint}`.
    // Re-check manager ownership after every terminal prompt result: a driver
    // whose assignment is no longer active must yield before it can mark the
    // parked node Failed or overwrite the newer resume generation.
    if (!(await assignmentIsCurrent(ctx.db ?? getDb(), execution))) {
      fenced = true;
      log.warn(
        {
          runId: ctx.runId,
          stepId: ctx.stepId,
          assignmentId: client.assignment.id,
          assignmentEpoch: client.assignment.epoch,
          hostSessionId: session.hostSessionId,
        },
        "driver-yielded after prompt completion",
      );

      return {
        ok: false,
        fenced: true,
        stdout: consumer.snapshot(),
        vars: {},
        durationMs: Date.now() - startedAt,
        errorCode: "CONFLICT" as const,
        acpSessionId: session.acpSessionId,
        sessionFallback,
      };
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
    const hookEscalated = consumer.hookTripEscalated();
    const hookEscalateFailed = consumer.hookTripEscalateFailed();

    // ADR-108 (M40): escalateHookTrip rejected after the pre-tx checkpoint — the
    // run is stranded Running with no hook_trip HITL. Surface CRASH (not a clean
    // checkpoint) so runFlow marks it Crashed and recover can session/resume.
    if (hookEscalateFailed) {
      log.error(
        {
          runId: ctx.runId,
          stepId: ctx.stepId,
          acpSessionId: session.acpSessionId,
        },
        "hook_trip escalation failed — STEP CRASH (stranded run)",
      );

      return {
        ok: false,
        stdout: consumer.snapshot(),
        vars: {},
        durationMs: Date.now() - startedAt,
        errorCode: "CRASH" as const,
        acpSessionId: session.acpSessionId,
        sessionFallback,
      };
    }

    // ADR-108 (M40): a halting guardrail trip already CAS'd Running→NeedsInput +
    // opened the hook_trip HITL inside escalateHookTrip. Surface STEP_CHECKPOINTED
    // (runGraph persists acpSessionId + pauses) but do NOT markCheckpointedFromExit
    // — the run stays NeedsInput so the hook_trip resume (runFlow) can re-enter.
    if (hookEscalated) {
      log.info(
        {
          runId: ctx.runId,
          stepId: ctx.stepId,
          stopReason: promptResult.stopReason,
          acpSessionId: session.acpSessionId,
        },
        "step halted by guardrail trip — STEP_CHECKPOINTED (NeedsInput)",
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

    const ok =
      !persistFailure &&
      (nodeCompletion?.ok ?? promptResult.stopReason === "end_turn");
    const errorCode = persistFailure
      ? ("CRASH" as const)
      : ok
        ? undefined
        : (nodeCompletion?.errorCode ?? "ACP_PROTOCOL");

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
      ...nodeCompletion,
      ok,
      stdout: nodeCompletion?.stdout ?? consumer.snapshot(),
      vars: nodeCompletion?.vars ?? {},
      durationMs: Date.now() - startedAt,
      errorCode,
      acpSessionId: session.acpSessionId,
      sessionFallback,
    };
  } catch (err) {
    if (err instanceof SessionCreatePending) {
      continuationPending = true;
      throw new FlowPromptContinuationPending(
        String(err.details?.commandId),
        err,
      );
    }
    if (err instanceof FlowPromptContinuationPending) {
      continuationPending = true;
      throw err;
    }
    // ADR-166 E-EH-11 (driver yield rule): `assignment_fenced` means a newer
    // driver generation owns this run — this incarnation must write no run,
    // ledger, HITL, or scratch state, and must not even tear the session down
    // (the host already evicted it under the newer epoch).
    if (isFencedError(err) || isFlowDriverClaimLost(err)) {
      fenced = true;
      log.warn(
        {
          runId: ctx.runId,
          stepId: ctx.stepId,
          assignmentId: client.assignment.id,
          assignmentEpoch: client.assignment.epoch,
          hostSessionId: session?.hostSessionId ?? null,
        },
        "driver-yielded",
      );

      return {
        ok: false,
        fenced: true,
        stdout: consumer?.snapshot() ?? "",
        vars: {},
        durationMs: Date.now() - startedAt,
        errorCode: "CONFLICT" as const,
        acpSessionId: session?.acpSessionId,
        sessionFallback,
      };
    }
    throw err;
  } finally {
    if (session && !fenced && !continuationPending) {
      await client
        .deleteSession(session.hostSessionId)
        .catch((err) =>
          log.warn(
            { err: (err as Error).message, sessionId: session?.sessionId },
            "deleteSession failed (non-fatal)",
          ),
        );
    }
  }
}
