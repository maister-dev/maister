import "server-only";

import type { ScratchDialogStatus, ScratchMessageRole } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { nextScratchMessageSequence } from "@/lib/scratch-runs/messages";
import { runStatusForDialogStatus } from "@/lib/scratch-runs/state";
import {
  encodePermissionPayload,
  encodeThoughtPayload,
  encodeToolPayload,
  encodeUsagePayload,
  interpretScratchUpdate,
  type ScratchToolStatus,
} from "@/lib/scratch-runs/transcript";
import {
  cancelPermission,
  sendPrompt,
  streamSession,
  type PromptContentBlock,
  type PromptResult,
  type SupervisorEvent,
} from "@/lib/supervisor-client";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { type AdapterId } from "@/lib/acp-runners/adapter-support";
import { normalizeCapabilityTokens } from "@/lib/capabilities/token-normalizer";

const { hitlRequests, runs, scratchMessages, scratchRuns } =
  schemaModule as unknown as Record<string, any>;

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

export type ScratchSupervisorApi = {
  cancelPermission: typeof cancelPermission;
  sendPrompt: typeof sendPrompt;
  streamSession: typeof streamSession;
};

const defaultSupervisorApi: ScratchSupervisorApi = {
  cancelPermission,
  sendPrompt,
  streamSession,
};

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
      reason?: "checkpoint" | "intentional";
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
    };

// Dialog-status / HITL side effects only. Message content is produced by the
// stateful consumer below (it must coalesce streamed chunks and tool-call
// lifecycles, which a pure per-event mapper cannot do). `session.line` carries
// the raw ACP JSON-RPC transport frames and is intentionally not projected.
export function projectSupervisorEventToScratch(
  event: MinimalSupervisorEvent,
): ScratchSupervisorEventProjection {
  switch (event.type) {
    case "session.permission_request":
      return { dialogStatus: "NeedsInput", hitlRequestId: event.requestId };
    case "session.exited":
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
  role: ScratchMessageRole;
  content: string;
  supervisorEventId?: string;
}): Promise<string> {
  const sequenceRows: Array<{ sequence: number }> = await args.db
    .select({ sequence: scratchMessages.sequence })
    .from(scratchMessages)
    .where(eq(scratchMessages.runId, args.runId));
  const sequence = nextScratchMessageSequence(
    sequenceRows.map((row) => row.sequence),
  );
  const id = randomUUID();

  await args.db.insert(scratchMessages).values({
    id,
    runId: args.runId,
    sequence,
    role: args.role,
    content: args.content,
    supervisorEventId: args.supervisorEventId ?? null,
    createdAt: new Date(),
  });

  return id;
}

async function updateScratchMessageRow(args: {
  db: DbClientLike;
  messageId: string;
  content: string;
}): Promise<void> {
  await args.db
    .update(scratchMessages)
    .set({ content: args.content })
    .where(eq(scratchMessages.id, args.messageId));
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

async function persistPermissionRequest(args: {
  db: DbClientLike;
  runId: string;
  stepId: string;
  sessionId: string;
  event: Extract<SupervisorEvent, { type: "session.permission_request" }>;
  api: ScratchSupervisorApi;
}): Promise<void> {
  const hitlRequestId = randomUUID();
  const prompt = permissionPrompt(args.event);

  try {
    await args.db.transaction(async (tx: DbClientLike) => {
      await tx.insert(hitlRequests).values({
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
    await args.api.cancelPermission(
      args.sessionId,
      args.event.requestId,
      `DB_PERSIST_FAILED:${message.slice(0, 128)}`,
    );
    throw err;
  }
}

type ToolRowState = {
  id: string;
  name: string;
  toolKind: string;
  status: ScratchToolStatus;
  arg: string;
  rawInput: unknown;
  result: string;
};

// Per-turn coalescing buffers. Streamed assistant/thought text arrives as many
// chunks (often empty) and tool calls arrive as a `tool_call` followed by
// several `tool_call_update`s sharing a toolCallId — these are merged into a
// single message row each. The consumer is serialized, so this in-memory state
// is race-free.
function createTranscriptProjector(args: { db: DbClientLike; runId: string }) {
  let openText: { id: string; text: string } | null = null;
  let openThought: { id: string; text: string } | null = null;
  let usageRow: { id: string } | null = null;
  const toolsByCallId = new Map<string, ToolRowState>();

  function resetOpenText(): void {
    openText = null;
    openThought = null;
  }

  async function handleUpdate(
    update: unknown,
    supervisorEventId: string,
  ): Promise<void> {
    const interpreted = interpretScratchUpdate(update);

    if (!interpreted) return;

    switch (interpreted.kind) {
      case "text": {
        openThought = null;
        if (openText) {
          openText.text += interpreted.text;
          await updateScratchMessageRow({
            db: args.db,
            messageId: openText.id,
            content: openText.text,
          });
        } else {
          const id = await appendScratchMessageRow({
            db: args.db,
            runId: args.runId,
            role: "assistant",
            content: interpreted.text,
            supervisorEventId,
          });

          openText = { id, text: interpreted.text };
        }

        return;
      }
      case "thought": {
        openText = null;
        if (openThought) {
          openThought.text += interpreted.text;
          await updateScratchMessageRow({
            db: args.db,
            messageId: openThought.id,
            content: encodeThoughtPayload(openThought.text),
          });
        } else {
          const text = interpreted.text;
          const id = await appendScratchMessageRow({
            db: args.db,
            runId: args.runId,
            role: "system",
            content: encodeThoughtPayload(text),
            supervisorEventId,
          });

          openThought = { id, text };
        }

        return;
      }
      case "tool_call": {
        resetOpenText();
        const state: Omit<ToolRowState, "id"> = {
          name: interpreted.name,
          toolKind: interpreted.toolKind,
          status: interpreted.status,
          arg: interpreted.arg,
          rawInput: interpreted.rawInput,
          result: interpreted.result,
        };
        const id = await appendScratchMessageRow({
          db: args.db,
          runId: args.runId,
          role: "tool",
          content: encodeToolPayload(state),
          supervisorEventId,
        });

        toolsByCallId.set(interpreted.toolCallId, { id, ...state });

        return;
      }
      case "tool_update": {
        const existing = toolsByCallId.get(interpreted.toolCallId);

        if (!existing) {
          const state: Omit<ToolRowState, "id"> = {
            name: interpreted.name ?? "tool",
            toolKind: interpreted.toolKind ?? "other",
            status: interpreted.status ?? "pending",
            arg: interpreted.arg ?? "",
            rawInput: interpreted.rawInput ?? null,
            result: interpreted.result ?? "",
          };
          const id = await appendScratchMessageRow({
            db: args.db,
            runId: args.runId,
            role: "tool",
            content: encodeToolPayload(state),
            supervisorEventId,
          });

          toolsByCallId.set(interpreted.toolCallId, { id, ...state });

          return;
        }

        if (interpreted.name) existing.name = interpreted.name;
        if (interpreted.toolKind) existing.toolKind = interpreted.toolKind;
        if (interpreted.status) existing.status = interpreted.status;
        if (interpreted.arg && !existing.arg) existing.arg = interpreted.arg;
        if (interpreted.rawInput !== undefined) {
          existing.rawInput = interpreted.rawInput;
        }
        if (interpreted.result) {
          existing.result = existing.result
            ? `${existing.result}\n${interpreted.result}`
            : interpreted.result;
        }
        await updateScratchMessageRow({
          db: args.db,
          messageId: existing.id,
          content: encodeToolPayload(existing),
        });

        return;
      }
      case "usage": {
        const content = encodeUsagePayload(interpreted.used, interpreted.size);

        if (usageRow) {
          await updateScratchMessageRow({
            db: args.db,
            messageId: usageRow.id,
            content,
          });
        } else {
          const id = await appendScratchMessageRow({
            db: args.db,
            runId: args.runId,
            role: "system",
            content,
            supervisorEventId,
          });

          usageRow = { id };
        }

        return;
      }
    }
  }

  return { handleUpdate, resetOpenText };
}

function startScratchEventConsumer(args: {
  db: DbClientLike;
  runId: string;
  stepId: string;
  sessionId: string;
  api: ScratchSupervisorApi;
}) {
  const abort = new AbortController();
  let permissionPersistFailure: { reason: string } | null = null;
  const projector = createTranscriptProjector({
    db: args.db,
    runId: args.runId,
  });

  // Events are projected sequentially: each write commits before the next event
  // is read. Sequence allocation is read-modify-write (appendScratchMessageRow),
  // so concurrent appends would all read the same max and collide on
  // scratch_messages_run_sequence_uq. Sequential projection also preserves
  // monotonic transcript order and keeps the coalescing buffers race-free.
  const done = (async () => {
    try {
      for await (const event of args.api.streamSession(args.sessionId, {
        signal: abort.signal,
      })) {
        if (event.type === "session.permission_request") {
          try {
            await persistPermissionRequest({
              db: args.db,
              runId: args.runId,
              stepId: args.stepId,
              sessionId: args.sessionId,
              event,
              api: args.api,
            });
            projector.resetOpenText();
          } catch (err) {
            if (!permissionPersistFailure) {
              permissionPersistFailure = {
                reason: err instanceof Error ? err.message : String(err),
              };
            }
          }
          continue;
        }

        try {
          if (event.type === "session.update") {
            await projector.handleUpdate(
              event.update,
              String(event.monotonicId),
            );
          } else {
            const projection = projectSupervisorEventToScratch(event);

            if (projection.dialogStatus) {
              const dialogStatus = projection.dialogStatus;

              await args.db.transaction(async (tx: DbClientLike) => {
                const applied = await applyDialogStatus({
                  db: tx,
                  runId: args.runId,
                  dialogStatus,
                });

                // Live scratch terminal path (not reconcile/markScratchCrashed):
                // emit on the CAS winner only. Done/Abandoned arrive via
                // promote/drop and are wired there; here only Crashed/Review.
                // ADR-097: a project-less local-package run skips these
                // project-scoped emits (no project to attribute them to).
                if (applied?.projectId && dialogStatus === "Crashed") {
                  await emitWebhookEvent({
                    db: tx,
                    type: "run.crashed",
                    projectId: applied.projectId,
                    runId: args.runId,
                    data: { errorCode: "CRASH" },
                  });
                  await emitDomainEvent({
                    db: tx,
                    kind: "run.crashed",
                    projectId: applied.projectId,
                    runId: args.runId,
                    actor: { type: "system", id: null },
                    // scratch runs are never delegated children
                    parentRunId: null,
                    payload: {
                      runId: args.runId,
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
                    runId: args.runId,
                    data: { source: "runner" },
                  });
                }
              });
            }
          }
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

export async function sendScratchPromptAndProjectEvents(args: {
  runId: string;
  sessionId: string;
  stepId: string;
  prompt: string;
  contentBlocks?: PromptContentBlock[];
  db?: DbClientLike;
  api?: ScratchSupervisorApi;
}): Promise<PromptResult> {
  const db = args.db ?? getDb();
  const api = args.api ?? defaultSupervisorApi;
  const consumer = startScratchEventConsumer({
    db,
    runId: args.runId,
    stepId: args.stepId,
    sessionId: args.sessionId,
    api,
  });

  let promptResult: PromptResult;

  try {
    promptResult = await api.sendPrompt(args.sessionId, {
      stepId: args.stepId,
      prompt: args.prompt,
      contentBlocks: args.contentBlocks,
    });
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
