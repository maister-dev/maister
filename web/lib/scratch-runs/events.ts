import "server-only";

import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { ScratchDialogStatus } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import {
  ScratchPromptQuarantined,
  waitForScratchPrompt,
  type ScratchPromptOwner,
} from "./prompt-owner";
import { admitFrozenScratchPrompt } from "./prompt-intent";
import { lockScratchRunRows } from "./turn-completion";

import { createHitlRequest } from "@/lib/runs/hitl-create";
import { getDb } from "@/lib/db/client";
import { waitForPromptIncarnation } from "@/lib/execution-host/prompt-incarnation";
import * as schemaModule from "@/lib/db/schema";
import { appendScratchMessage } from "@/lib/scratch-runs/messages";
import { closeOpenScratchPermissions } from "@/lib/scratch-runs/open-permissions";
import { closedAnswerResponse } from "@/lib/hitl-closed-answer";
import {
  isTerminalScratchDialogStatus,
  runStatusForDialogStatus,
} from "@/lib/scratch-runs/state";
import {
  encodeHookTripPayload,
  encodePermissionPayload,
} from "@/lib/scratch-runs/transcript";
import {
  type PromptContentBlock,
  type PromptResult,
  type SupervisorEvent,
} from "@/lib/execution-host";
import {
  createExecutionHosts,
  type BoundClient,
  type HostAdminClient,
} from "@/lib/execution-host";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { type AdapterId } from "@/lib/acp-runners/adapter-support";
import { normalizeCapabilityTokens } from "@/lib/capabilities/token-normalizer";

const {
  hitlRequests,
  runs,
  runSessionIncarnations,
  runSessions,
  scratchMessages,
  scratchRuns,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "scratch-events",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * Normalize canonical capability tokens in a scratch prompt to the run's runner
 * wire form (FR-E2). Web-side only — the supervisor forwards the result
 * verbatim. A capability the runner cannot honor is degraded + WARNed (FR-E5),
 * never a hard fail. No-op on token-free text (verbatim-forward).
 */
export function normalizeScratchPrompt(
  rawPrompt: string,
  agent: AdapterId | string | null | undefined,
  meta: { runId: string },
): string {
  const resolved = (agent ?? "claude") as AdapterId;
  const { text, warnings } = normalizeCapabilityTokens(rawPrompt, resolved);

  if (warnings.length > 0) {
    log.warn(
      { runId: meta.runId, agent: resolved, warnings },
      "[capability-tokens] referenced capability not available on runner — proceeding",
    );
  }

  return text;
}

type DbClientLike = any;

// ADR-166: a scratch turn talks to the host through the client bound to the
// run's execution assignment (prompt, permission input) and the host-scoped
// admin stream. Callers that already hold a binding pass it; the default binds
// the run's active assignment on the local host.
export type ScratchExecution = {
  client: BoundClient;
  admin: HostAdminClient;
};

export async function bindScratchExecution(
  db: DbClientLike,
  runId: string,
): Promise<ScratchExecution> {
  return createExecutionHosts({ db }).executionFor(runId);
}

export type ScratchSupervisorEventProjection = {
  dialogStatus?: ScratchDialogStatus;
  hitlRequestId?: string;
};

type MinimalSupervisorEvent =
  | {
      type: "session.line";
      monotonicId: number;
      line: string;
    }
  | {
      type: "session.update";
      monotonicId: number;
      update: unknown;
    }
  | {
      type: "session.permission_request";
      monotonicId: number;
      requestId: string;
    }
  | {
      type: "session.exited";
      monotonicId: number;
      reason?: "checkpoint" | "intentional" | "fenced";
    }
  | {
      type: "session.crashed";
      monotonicId: number;
    }
  // M30 (ADR-078 DD4, X-FANOUT): gate-chat turns never occur on scratch
  // sessions, but the union mirrors the supervisor event set so the
  // projection stays total.
  | {
      type: "session.chat_turn";
      monotonicId: number;
      hitlRequestId: string;
      role: "user" | "agent";
      body: string;
    }
  // ADR-108 (M40): mirrored to keep the projection total. A scratch hook_trip is
  // ignored here (default → {}); the scratch in-session deny + chat notice (no
  // NeedsInput, D2) is wired in Phase 3 (T3.3).
  | {
      type: "session.hook_trip";
      monotonicId: number;
      rule: "path_guard" | "repetition" | "no_progress" | "capability_guard";
      lifecycle: "pre_tool_call" | "post_turn";
      disposition: "deny" | "halt";
    }
  // ADR-166: command acceptance / completion signal for the enveloped session
  // routes. Consumed by the execution-host command ledger, never by the scratch
  // projection (default → {}), mirrored here to keep the projection total.
  | {
      type: "session.command";
      monotonicId: number;
      commandId: string;
      phase: "accepted" | "completed";
    };

// Dialog-status / HITL side effects only. The autonomous canonical transcript
// projector coalesces reply chunks and tool lifecycles; this request observer
// retains permission and hook notices. Raw `session.line` frames are not shown.
export function projectSupervisorEventToScratch(
  event: MinimalSupervisorEvent,
): ScratchSupervisorEventProjection {
  switch (event.type) {
    case "session.permission_request":
      return { dialogStatus: "NeedsInput", hitlRequestId: event.requestId };
    case "session.exited":
      // ADR-166 E-EH-11: an eviction for a newer driver generation is that
      // generation's to project — this consumer writes nothing.
      if (event.reason === "fenced") return {};

      return {
        dialogStatus:
          event.reason === "intentional" ? "Review" : "WaitingForUser",
      };
    case "session.crashed":
      return { dialogStatus: "Crashed" };
    default:
      return {};
  }
}

async function appendScratchMessageRow(args: {
  db: DbClientLike;
  runId: string;
  role: "system";
  content: string;
  supervisorEventId?: string;
}): Promise<string> {
  return (
    await args.db.transaction((tx: DbClientLike) =>
      appendScratchMessage(tx, args),
    )
  ).id;
}

async function applyDialogStatus(args: {
  db: DbClientLike;
  runId: string;
  dialogStatus: ScratchDialogStatus;
  // ADR-097: null for a project-less local-package assistant run — callers
  // guard the project-scoped emits on a non-null projectId.
}): Promise<{ projectId: string | null } | null> {
  const now = new Date();

  await args.db
    .update(scratchRuns)
    .set({ dialogStatus: args.dialogStatus, updatedAt: now })
    .where(eq(scratchRuns.runId, args.runId));
  const runRows: Array<{ projectId: string | null }> = await args.db
    .update(runs)
    .set({ status: runStatusForDialogStatus(args.dialogStatus) })
    .where(eq(runs.id, args.runId))
    .returning({ projectId: runs.projectId });

  return runRows[0] ?? null;
}

function permissionPrompt(
  event: Extract<
    SupervisorEvent,
    {
      type: "session.permission_request";
    }
  >,
): string {
  const toolCall = (event.toolCall ?? {}) as { title?: unknown };

  return typeof toolCall.title === "string"
    ? `Approve ${toolCall.title}?`
    : "Approve tool call?";
}

type PermissionRequestEvent = Extract<
  SupervisorEvent,
  { type: "session.permission_request" }
>;

/**
 * A scratch session respawned after a host park re-raises the permission its
 * interrupted turn was waiting on. The operator's answer is already stored on
 * that turn's request (response set, `responded_at` NULL), so it is delivered
 * here instead of asking again: the row is rebound in place to the new
 * request and session, the stored option goes out through the enveloped input
 * command, and `responded_at` is stamped on its ack. No new row, no
 * `NeedsInput` flip. Returns false when there is no stored answer to use (the
 * caller then records a fresh request).
 */
// What the operator approved: the tool, its input and the offered choices. The
// adapter mints a fresh `toolCallId` (and a subagent call's `_meta` parent id)
// for every call, `status` is the call's lifecycle, and an option's `name` can
// carry session state (ExitPlanMode's context usage) — none says whether a
// re-raised request is the same one. The option ids alone never do: they are
// the same for every tool. Null when the request cannot be canonicalized: an
// unreadable request never fits.
function permissionIdentity(
  toolCall: unknown,
  options: unknown,
): string | null {
  const {
    toolCallId: _toolCallId,
    status: _status,
    _meta,
    ...call
  } = (toolCall ?? {}) as Record<string, unknown>;
  const choices = (Array.isArray(options) ? options : []).map((option) => {
    const { optionId, kind } = (option ?? {}) as Record<string, unknown>;

    return { optionId: optionId ?? null, kind: kind ?? null };
  });

  try {
    return canonicalCommandJson({ toolCall: call, options: choices });
  } catch {
    return null;
  }
}

async function deliverStoredPermissionAnswer(args: {
  db: DbClientLike;
  runId: string;
  sessionId: string;
  event: PermissionRequestEvent;
  execution: ScratchExecution;
}): Promise<boolean> {
  const { event } = args;
  const rebound = await args.db.transaction(async (tx: DbClientLike) => {
    // The run row first, the respond route's order: the input command this
    // transaction issues takes a key-share lock on `runs`, so taking the HITL
    // row first would invert the route's `runs` → HITL order.
    await lockScratchRunRows(tx, args.runId);
    if (!(await canApplyScratchPermission(tx, args)))
      return "already_observed" as const;
    if (await hasScratchPermissionRequest(tx, args))
      return "already_observed" as const;
    const candidates = await tx
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, args.runId),
          eq(hitlRequests.kind, "permission"),
          isNotNull(hitlRequests.response),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.supersededAt),
          // Only an answer stored for an EARLIER session: on the live session
          // a request answered but not yet acked is that request's own
          // delivery in flight, never an answer for the next one.
          sql`${hitlRequests.schema}->>'supervisorSessionId' IS DISTINCT FROM ${args.sessionId}`,
        ),
      )
      .orderBy(desc(hitlRequests.createdAt))
      .for("update");
    const requested = permissionIdentity(event.toolCall, event.options);
    const identityOf = (row: { schema: unknown }) => {
      const schema = (row.schema ?? {}) as Record<string, unknown>;

      return permissionIdentity(schema.toolCall, schema.options);
    };
    // The answer for THIS request when several are stored (parallel requests
    // parked together) — else the newest, which a mismatch then retires.
    const stored =
      candidates.find(
        (row: { schema: unknown }) =>
          requested !== null && identityOf(row) === requested,
      ) ?? candidates[0];
    const optionId = (stored?.response as { optionId?: unknown } | null)
      ?.optionId;

    if (!stored || typeof optionId !== "string") return null;
    const schemaBefore = (stored.schema ?? {}) as Record<string, unknown>;
    const approved = identityOf(stored);

    if (approved === null || approved !== requested) {
      // A park that held several requests (parallel tool calls): this one may
      // be another of them, re-raised first. Nothing is retired — the stored
      // answers wait for their own re-raise or the turn's completion
      // (`not_requested`) — and this request is asked afresh.
      const [held] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.runId, args.runId),
            eq(hitlRequests.kind, "permission"),
            sql`${hitlRequests.schema}->>'supervisorSessionId' = ${String(schemaBefore.supervisorSessionId ?? "")}`,
            or(isNull(hitlRequests.respondedAt), isNull(hitlRequests.response)),
          ),
        );

      if ((held?.count ?? 0) > 1) {
        log.info(
          {
            runId: args.runId,
            requestId: event.requestId,
            parkedRequests: held.count,
          },
          "scratch-permission-stored-answers-kept-for-their-own-request",
        );

        return null;
      }
      // The resumed agent asked for something else — another tool, other
      // input, other choices. The operator never approved it, so the stored
      // answer is closed undelivered and the operator is asked afresh. Closed,
      // not superseded: a permission row supersedes only under an agent
      // checkpoint pause (the 0155 trigger).
      const at = new Date();

      await tx
        .update(hitlRequests)
        .set({
          respondedAt: at,
          response: closedAnswerResponse("request_changed", at),
        })
        .where(eq(hitlRequests.id, stored.id));
      log.warn(
        {
          runId: args.runId,
          hitlRequestId: stored.id,
          requestId: event.requestId,
        },
        "scratch-permission-stored-answer-does-not-fit",
      );

      return null;
    }
    await tx
      .update(hitlRequests)
      .set({
        schema: {
          ...schemaBefore,
          requestId: event.requestId,
          options: event.options,
          toolCall: event.toolCall,
          supervisorSessionId: args.sessionId,
        },
      })
      .where(eq(hitlRequests.id, stored.id));
    const prepared = await args.execution.client.prepareInput(
      tx,
      args.sessionId,
      {
        kind: "permission",
        action: "select",
        requestId: event.requestId,
        optionId,
      },
    );

    return {
      prepared,
      hitlRequestId: stored.id as string,
      response: stored.response as Record<string, unknown>,
      originalRequestId: schemaBefore.requestId ?? null,
    };
  });

  if (!rebound) return false;
  if (rebound === "already_observed") return true;
  try {
    await rebound.prepared.deliver({
      // No status write: the idle resume set the dialog `Running` before it
      // prompted, and this path never parks it. An ack can land after the turn
      // completed or the run ended, and must not overwrite either.
      onAck: async (tx: DbClientLike) => {
        const now = new Date();

        await tx
          .update(hitlRequests)
          .set({
            respondedAt: now,
            response: {
              ...rebound.response,
              _audit: {
                ...((rebound.response._audit as object | undefined) ?? {}),
                originalRequestId: rebound.originalRequestId,
                reissuedRequestId: event.requestId,
                deliveredViaResume: true,
              },
            },
          })
          .where(
            and(
              eq(hitlRequests.id, rebound.hitlRequestId),
              isNull(hitlRequests.respondedAt),
            ),
          );
      },
    });
    log.info(
      {
        runId: args.runId,
        hitlRequestId: rebound.hitlRequestId,
        requestId: event.requestId,
      },
      "scratch-permission-stored-answer-delivered",
    );
  } catch (err) {
    // The answer stays stored on the rebound row; surfacing the request as a
    // pending permission lets the operator's identical retry deliver it
    // through the live respond path. Only while this delivery still owns the
    // dialog: a failure can land after the session crashed, the turn ended or
    // the run was stopped, and must not overwrite that.
    const surface = () =>
      args.db.transaction(async (tx: DbClientLike) => {
        await lockScratchRunRows(tx, args.runId);
        if (!(await canApplyScratchPermission(tx, args))) return false;
        const [run] = await tx
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, args.runId));
        const [scratch] = await tx
          .select({ dialogStatus: scratchRuns.dialogStatus })
          .from(scratchRuns)
          .where(eq(scratchRuns.runId, args.runId));
        const [row] = await tx
          .select({
            respondedAt: hitlRequests.respondedAt,
            schema: hitlRequests.schema,
          })
          .from(hitlRequests)
          .where(eq(hitlRequests.id, rebound.hitlRequestId))
          .for("update");
        const bound = (row?.schema ?? {}) as Record<string, unknown>;

        if (
          run?.status !== "Running" ||
          scratch?.dialogStatus !== "Running" ||
          !row ||
          row.respondedAt !== null ||
          bound.supervisorSessionId !== args.sessionId ||
          bound.requestId !== event.requestId
        )
          return false;
        await applyDialogStatus({
          db: tx,
          runId: args.runId,
          dialogStatus: "NeedsInput",
        });

        return true;
      });
    // One retry (a deadlock victim, say). A second failure escapes to the
    // caller's catch, which cancels the agent's request: better than leaving
    // it waiting on an answer nobody can deliver.
    const surfaced = await surface().catch((surfaceErr: unknown) => {
      log.warn(
        {
          runId: args.runId,
          hitlRequestId: rebound.hitlRequestId,
          err:
            surfaceErr instanceof Error
              ? surfaceErr.message
              : String(surfaceErr),
        },
        "scratch-permission-stored-answer-surface-retried",
      );

      return surface();
    });

    log.warn(
      {
        runId: args.runId,
        hitlRequestId: rebound.hitlRequestId,
        requestId: event.requestId,
        surfaced,
        err: err instanceof Error ? err.message : String(err),
      },
      "scratch-permission-stored-answer-delivery-failed",
    );
  }

  return true;
}

async function hasScratchPermissionRequest(
  tx: DbClientLike,
  input: { runId: string; sessionId: string; event: PermissionRequestEvent },
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: hitlRequests.id })
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, input.runId),
        eq(hitlRequests.kind, "permission"),
        sql`${hitlRequests.schema}->>'supervisorSessionId' = ${input.sessionId}`,
        sql`${hitlRequests.schema}->>'requestId' = ${input.event.requestId}`,
      ),
    )
    .limit(1);

  return existing !== undefined;
}

async function persistPermissionRequest(args: {
  db: DbClientLike;
  runId: string;
  stepId: string;
  sessionId: string;
  event: PermissionRequestEvent;
  execution: ScratchExecution;
}): Promise<void> {
  const hitlRequestId = randomUUID();
  const prompt = permissionPrompt(args.event);

  try {
    // Inside the guard: a failed lookup must release the host's deferred like
    // a failed insert, or the agent hangs on a request nobody can answer.
    if (await deliverStoredPermissionAnswer(args)) return;
    await args.db.transaction(async (tx: DbClientLike) => {
      // Multiple re-drivers may observe the same host event. The run lock
      // serializes notice creation with stored-answer rebinding and Stop.
      await lockScratchRunRows(tx, args.runId);
      if (!(await canApplyScratchPermission(tx, args))) return;
      if (await hasScratchPermissionRequest(tx, args)) return;
      await createHitlRequest(tx, {
        id: hitlRequestId,
        runId: args.runId,
        stepId: args.stepId,
        kind: "permission",
        schema: {
          requestId: args.event.requestId,
          options: args.event.options,
          toolCall: args.event.toolCall,
          supervisorSessionId: args.sessionId,
        },
        prompt,
      });
      const applied = await applyDialogStatus({
        db: tx,
        runId: args.runId,
        dialogStatus: "NeedsInput",
      });

      await appendScratchMessageRow({
        db: tx,
        runId: args.runId,
        role: "system",
        content: encodePermissionPayload(prompt),
        supervisorEventId: String(args.event.monotonicId),
      });

      // ADR-097: a project-less local-package run has no project to attribute
      // these project-scoped webhooks to — skip them (the HITL row + scratch
      // dialog status are the live record; the assistant has no webhook subs).
      if (applied?.projectId) {
        const projectId = applied.projectId;

        await emitWebhookEvent({
          db: tx,
          type: "hitl.requested",
          projectId,
          runId: args.runId,
          data: { hitlRequestId, kind: "permission", nodeId: null },
        });
        await emitWebhookEvent({
          db: tx,
          type: "run.needs_input",
          projectId,
          runId: args.runId,
          data: { reason: "permission", nodeId: null },
        });
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.error(
      {
        runId: args.runId,
        requestId: args.event.requestId,
        err: message,
      },
      "scratch permission persistence failed — cancelling supervisor deferred",
    );
    await args.execution.client.deliverInput(args.sessionId, {
      kind: "permission",
      action: "cancel",
      requestId: args.event.requestId,
      reason: `DB_PERSIST_FAILED:${message.slice(0, 128)}`,
    });
    throw err;
  }
}

// `supervisor_event_id` carries TWO number spaces on a scratch run. The
// canonical projector stamps `execution_events.run_sequence` on the reply rows
// it owns; the notices below stamp the supervisor's per-session `monotonicId`.
// Only the latter addresses the SSE stream, and the supervisor drops every
// event whose id is <= the cursor — replay AND live alike — so a cursor taken
// across both spaces eats the opening events of a follow-up turn, a dropped
// `session.permission_request` among them. Role discriminates the writers: the
// canonical projector only ever inserts `assistant` / `tool`. Reply content
// itself is owned by the durable canonical transcript cursor, independently of
// this stack; this offset only starts the live permission / lifecycle observer
// after retained notice history.
//
// INVARIANT this rests on: a run with no notice row has no offset and replays
// the host's retained buffer from the start, which must be a no-op. It is,
// because every event this consumer ACTS on also writes a notice row —
// `session.permission_request` and `session.hook_trip` — so their absence
// proves none occurred, and the only other dialog-status events
// (`session.exited` / `session.crashed`, see `projectSupervisorEventToScratch`)
// are terminal, after which no further turn is sent through the session.
// Adding a dialog-status event that writes NO notice row breaks this.
const NOTICE_MESSAGE_ROLES = ["user", "system"];

// The monotonic id is PER SESSION: a session respawned by Recover or an idle
// resume counts from 1 again. So only the notices written while THIS host
// session ran address its stream — an older session's higher ids would make
// the host drop the new session's opening events, the re-raised permission
// among them. Those notices are the rows created since the session's first
// incarnation.
async function hostSessionStartedAt(
  db: DbClientLike,
  runId: string,
  hostSessionId: string,
): Promise<Date | null> {
  const rows: Array<{ createdAt: Date }> = await db
    .select({ createdAt: runSessionIncarnations.createdAt })
    .from(runSessionIncarnations)
    .innerJoin(
      runSessions,
      eq(runSessions.id, runSessionIncarnations.runSessionId),
    )
    .where(
      and(
        eq(runSessions.runId, runId),
        eq(runSessionIncarnations.hostSessionId, hostSessionId),
      ),
    )
    .orderBy(runSessionIncarnations.createdAt)
    .limit(1);

  return rows[0]?.createdAt ?? null;
}

export async function scratchNoticeResumeOffset(
  db: DbClientLike,
  runId: string,
  hostSessionId?: string,
): Promise<number | undefined> {
  try {
    const since = hostSessionId
      ? await hostSessionStartedAt(db, runId, hostSessionId)
      : null;
    const rows: Array<{ supervisorEventId: string | null }> = await db
      .select({
        supervisorEventId: scratchMessages.supervisorEventId,
      })
      .from(scratchMessages)
      .where(
        and(
          eq(scratchMessages.runId, runId),
          isNull(scratchMessages.nodeAttemptId),
          inArray(scratchMessages.role, NOTICE_MESSAGE_ROLES),
          since ? gte(scratchMessages.createdAt, since) : undefined,
        ),
      );
    const maxId = rows.reduce<number | undefined>((current, row) => {
      if (!row.supervisorEventId) return current;
      const parsed = Number.parseInt(row.supervisorEventId, 10);

      if (!Number.isFinite(parsed)) return current;

      return current === undefined ? parsed : Math.max(current, parsed);
    }, undefined);

    return maxId;
    // A failed offset read must NOT abort the consumer — fall back to streaming
    // from the start (at worst a one-time re-projection, never a dead turn).
  } catch (err) {
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "scratch resume-offset read failed; streaming from start",
    );

    return undefined;
  }
}

async function scratchEventIncarnation(
  tx: ExecutionDb,
  input: { runId: string; hostSessionId: string; executionHostId: string },
): Promise<{
  assignmentId: string | null;
  observedIncarnationId: string | null;
  currentIncarnationId: string | null;
}> {
  const [run] = await tx
    .select({ assignmentId: schemaModule.runs.executionAssignmentId })
    .from(schemaModule.runs)
    .where(eq(schemaModule.runs.id, input.runId));
  const [observed] = await tx
    .select({ id: schemaModule.runSessionIncarnations.id })
    .from(schemaModule.runSessionIncarnations)
    .where(
      and(
        eq(schemaModule.runSessionIncarnations.runId, input.runId),
        eq(
          schemaModule.runSessionIncarnations.executionHostId,
          input.executionHostId,
        ),
        eq(
          schemaModule.runSessionIncarnations.hostSessionId,
          input.hostSessionId,
        ),
      ),
    );
  const [current] = run?.assignmentId
    ? await tx
        .select({ id: schemaModule.runSessionIncarnations.id })
        .from(schemaModule.runSessions)
        .innerJoin(
          schemaModule.runSessionIncarnations,
          and(
            eq(
              schemaModule.runSessionIncarnations.runSessionId,
              schemaModule.runSessions.id,
            ),
            eq(
              schemaModule.runSessionIncarnations.hostSessionId,
              schemaModule.runSessions.hostSessionId,
            ),
            eq(
              schemaModule.runSessionIncarnations.executionAssignmentId,
              schemaModule.runSessions.executionAssignmentId,
            ),
          ),
        )
        .where(
          and(
            eq(schemaModule.runSessions.runId, input.runId),
            eq(schemaModule.runSessions.sessionName, "default"),
            eq(
              schemaModule.runSessions.executionAssignmentId,
              run.assignmentId,
            ),
          ),
        )
    : [];

  return {
    assignmentId: run?.assignmentId ?? null,
    observedIncarnationId: observed?.id ?? null,
    currentIncarnationId: current?.id ?? null,
  };
}

/** Call under run → scratch locks before any permission or answer mutation. */
async function canApplyScratchPermission(
  tx: ExecutionDb,
  args: {
    runId: string;
    sessionId: string;
    event: PermissionRequestEvent;
    execution: ScratchExecution;
  },
): Promise<boolean> {
  const [state] = await tx
    .select({
      status: schemaModule.runs.status,
      dialogStatus: schemaModule.scratchRuns.dialogStatus,
    })
    .from(schemaModule.runs)
    .innerJoin(
      schemaModule.scratchRuns,
      eq(schemaModule.scratchRuns.runId, schemaModule.runs.id),
    )
    .where(eq(schemaModule.runs.id, args.runId));
  const incarnation = await scratchEventIncarnation(tx, {
    runId: args.runId,
    hostSessionId: args.sessionId,
    executionHostId: args.execution.client.host.id,
  });

  if (
    state &&
    ["Running", "NeedsInput"].includes(state.status) &&
    ["Starting", "Running", "NeedsInput"].includes(state.dialogStatus) &&
    incarnation.observedIncarnationId !== null &&
    incarnation.observedIncarnationId === incarnation.currentIncarnationId
  )
    return true;
  log.info(
    {
      runId: args.runId,
      hostSessionId: args.sessionId,
      requestId: args.event.requestId,
      status: state?.status ?? null,
      dialogStatus: state?.dialogStatus ?? null,
      ...incarnation,
    },
    "scratch-stale-permission-ignored",
  );

  return false;
}

/** Transactional terminal projection shared with the already-read event control. */
export async function applyScratchSessionTerminal(input: {
  db: ExecutionDb;
  runId: string;
  hostSessionId: string;
  executionHostId: string;
  event: Extract<
    SupervisorEvent,
    { type: "session.exited" | "session.crashed" }
  >;
}): Promise<void> {
  const projection = projectSupervisorEventToScratch(input.event);

  if (!projection.dialogStatus) return;
  const dialogStatus = projection.dialogStatus;

  const parked = await input.db.transaction(async (tx): Promise<boolean> => {
    await lockScratchRunRows(tx, input.runId);
    const incarnation = await scratchEventIncarnation(tx, input);

    // Incarnation identity survives canonical terminal projection. Neither an
    // ACP resume handle nor a non-terminal state proves current ownership.
    if (
      !incarnation.observedIncarnationId ||
      incarnation.observedIncarnationId !== incarnation.currentIncarnationId
    ) {
      log.info(
        {
          runId: input.runId,
          hostSessionId: input.hostSessionId,
          executionHostId: input.executionHostId,
          ...incarnation,
          eventType: input.event.type,
          monotonicId: input.event.monotonicId,
        },
        "scratch-stale-incarnation-terminal-ignored",
      );

      return false;
    }
    const [scratch] = await tx
      .select({ dialogStatus: schemaModule.scratchRuns.dialogStatus })
      .from(schemaModule.scratchRuns)
      .where(eq(schemaModule.scratchRuns.runId, input.runId));

    if (!scratch || isTerminalScratchDialogStatus(scratch.dialogStatus))
      return false;
    if (
      input.event.type === "session.exited" &&
      input.event.reason === "checkpoint" &&
      scratch.dialogStatus === "NeedsInput"
    ) {
      const { markCheckpointedFromExit } = await import(
        "@/lib/runs/state-transitions"
      );
      const result = await markCheckpointedFromExit(input.runId, { db: tx });

      log.info(
        { runId: input.runId, parked: result.ok },
        "scratch-permission-parked",
      );

      return result.ok;
    }
    const applied = await applyDialogStatus({
      db: tx,
      runId: input.runId,
      dialogStatus,
    });

    // Live scratch terminal path (not reconcile/markScratchCrashed):
    // emit on the CAS winner only. Done/Abandoned arrive via
    // promote/drop and are wired there; here only Crashed/Review.
    // ADR-097: a project-less local-package run skips these
    // project-scoped emits (no project to attribute them to).
    if (dialogStatus === "Crashed")
      await closeOpenScratchPermissions(tx, input.runId, new Date());
    if (applied?.projectId && dialogStatus === "Crashed") {
      await emitWebhookEvent({
        db: tx,
        type: "run.crashed",
        projectId: applied.projectId,
        runId: input.runId,
        data: { errorCode: "CRASH" },
      });
      await emitDomainEvent({
        db: tx,
        kind: "run.crashed",
        projectId: applied.projectId,
        runId: input.runId,
        actor: { type: "system", id: null },
        // scratch runs are never delegated children
        parentRunId: null,
        cause: {
          code: "CRASH",
          reason: "session_crashed",
          source: "scratch",
        },
        payload: {
          runId: input.runId,
          taskId: null,
          flowId: null,
          runKind: "scratch",
          reason: "CRASH",
        },
      });
    } else if (applied?.projectId && dialogStatus === "Review") {
      await emitWebhookEvent({
        db: tx,
        type: "run.review",
        projectId: applied.projectId,
        runId: input.runId,
        data: { source: "runner" },
      });
    }

    return false;
  });

  // Admission owns the scheduler lock; enter it only after releasing run locks.
  if (parked) {
    const { releaseSlotOnIdle } = await import("@/lib/scheduler");

    await releaseSlotOnIdle({ runId: input.runId, db: input.db }).catch(
      (err: unknown) =>
        log.warn(
          { runId: input.runId, err },
          "scratch permission park could not promote queued work",
        ),
    );
  }
}

function startScratchEventConsumer(args: {
  db: DbClientLike;
  runId: string;
  stepId: string;
  sessionId: string;
  execution: ScratchExecution;
}) {
  const abort = new AbortController();
  let permissionPersistFailure: { reason: string } | null = null;

  // Permission and lifecycle effects remain sequential. Reply projection runs
  // autonomously and shares the message allocator with these local notices.
  const done = (async () => {
    try {
      // Resume after the last event we already projected so a follow-up prompt
      // does not re-stream (and re-persist) the whole session history.
      const lastEventId = await scratchNoticeResumeOffset(
        args.db,
        args.runId,
        args.sessionId,
      );

      for await (const event of args.execution.admin.streamSession(
        args.sessionId,
        { lastEventId, signal: abort.signal },
      )) {
        if (event.type === "session.permission_request") {
          try {
            await persistPermissionRequest({
              db: args.db,
              runId: args.runId,
              stepId: args.stepId,
              sessionId: args.sessionId,
              event,
              execution: args.execution,
            });
          } catch (err) {
            if (!permissionPersistFailure) {
              permissionPersistFailure = {
                reason: err instanceof Error ? err.message : String(err),
              };
            }
          }
          continue;
        }

        if (event.type === "session.hook_trip") {
          // ADR-108 (M40): scratch never escalates to NeedsInput (D2) — surface
          // the trip as an in-session chat notice only. A path_guard deny already
          // denied the tool inline (deny-and-continue); a halt ends the turn (the
          // run then goes WaitingForUser via the natural session.exited). No
          // dialogStatus change here.
          try {
            await appendScratchMessageRow({
              db: args.db,
              runId: args.runId,
              role: "system",
              content: encodeHookTripPayload(event.rule, event.disposition),
              supervisorEventId: String(event.monotonicId),
            });
          } catch (err) {
            log.warn(
              { sessionId: args.sessionId, err: (err as Error).message },
              "scratch hook_trip notice write failed",
            );
          }
          continue;
        }

        try {
          if (
            event.type === "session.exited" ||
            event.type === "session.crashed"
          )
            await applyScratchSessionTerminal({
              db: args.db,
              runId: args.runId,
              hostSessionId: args.sessionId,
              executionHostId: args.execution.client.host.id,
              event,
            });
        } catch (err) {
          log.warn(
            {
              sessionId: args.sessionId,
              monotonicId: event.monotonicId,
              err: (err as Error).message,
            },
            "scratch projection write failed",
          );
        }

        if (
          event.type === "session.exited" ||
          event.type === "session.crashed"
        ) {
          break;
        }
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      log.warn(
        { sessionId: args.sessionId, err: (err as Error).message },
        "scratch event consumer error",
      );
    }
  })();

  return {
    abort,
    done,
    permissionPersistFailure: () => permissionPersistFailure,
  };
}

type ScratchPromptSend = {
  runId: string;
  sessionId: string;
  stepId: string;
  prompt: string;
  contentBlocks?: PromptContentBlock[];
  db?: DbClientLike;
  execution?: ScratchExecution;
  // S2.9: the durable dialog turn that owns this prompt's application. Absent
  // callers keep the pre-owner stack completion until their arm lands.
  // S2.12: required — a scratch turn nothing owns cannot be finished after a
  // restart, so there is no unowned prompt to send.
  owner: ScratchPromptOwner;
  // Optional cancel forwarded to the supervisor prompt fetch (staged assistant
  // launch passes its request signal); a disconnect aborts the in-flight turn.
  signal?: AbortSignal;
};

export async function sendScratchPromptAndProjectEvents(
  args: ScratchPromptSend,
): Promise<PromptResult> {
  try {
    return await sendAndProjectScratchPrompt(args);
  } catch (err) {
    // ADR-184 amendment 2026-09-28: a quarantined turn has no writer left, so
    // it fails here — once its events stopped projecting — instead of
    // yielding forever. Every caller then treats it as yielded.
    if (err instanceof ScratchPromptQuarantined) {
      const { markScratchPromptRetryable } = await import("./service");

      await markScratchPromptRetryable({
        db: args.db ?? getDb(),
        runId: args.runId,
        err,
      }).catch((markErr: unknown) =>
        log.error(
          {
            runId: args.runId,
            markErr:
              markErr instanceof Error ? markErr.message : String(markErr),
          },
          "failed to mark a quarantined scratch turn retryable",
        ),
      );
    }
    throw err;
  }
}

async function sendAndProjectScratchPrompt(
  args: ScratchPromptSend,
): Promise<PromptResult> {
  const db = args.db ?? getDb();
  const execution =
    args.execution ?? (await bindScratchExecution(db, args.runId));
  const consumer = startScratchEventConsumer({
    db,
    runId: args.runId,
    stepId: args.stepId,
    sessionId: args.sessionId,
    execution,
  });

  let promptResult: PromptResult;

  try {
    const owner = args.owner;

    // The create ACK projects the incarnation asynchronously; an owned prompt
    // must admit against the live binding, exactly like Flow and agent turns.
    await waitForPromptIncarnation(
      db,
      execution.client,
      args.sessionId,
      args.signal,
    );
    const handle = await execution.client.prompt(
      args.sessionId,
      {
        stepId: args.stepId,
        prompt: args.prompt,
        contentBlocks: args.contentBlocks,
      },
      {
        signal: args.signal,
        admitOwner: (tx: DbClientLike) =>
          admitFrozenScratchPrompt(
            tx,
            execution.client,
            args.sessionId,
            owner,
            {
              stepId: args.stepId,
              prompt: args.prompt,
              contentBlocks: args.contentBlocks,
            },
          ),
      },
    );

    await waitForScratchPrompt(
      db,
      execution.client,
      handle.commandId,
      args.signal,
    );
    promptResult = { stopReason: "end_turn", meta: null };
  } finally {
    consumer.abort.abort();
    await consumer.done;
  }

  const persistFailure = consumer.permissionPersistFailure();

  if (persistFailure) {
    throw new Error(persistFailure.reason);
  }

  return promptResult;
}
