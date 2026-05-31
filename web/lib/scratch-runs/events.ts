import "server-only";

import type { ScratchDialogStatus, ScratchMessageRole } from "@/lib/db/schema";
import type { ScratchMessageDraft } from "@/lib/scratch-runs/types";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { nextScratchMessageSequence } from "@/lib/scratch-runs/messages";
import { runStatusForDialogStatus } from "@/lib/scratch-runs/state";
import {
  cancelPermission,
  sendPrompt,
  streamSession,
  type PromptResult,
  type SupervisorEvent,
} from "@/lib/supervisor-client";

const { hitlRequests, runs, scratchMessages, scratchRuns } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "scratch-events",
  level: process.env.LOG_LEVEL ?? "info",
});

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
  message?: Omit<ScratchMessageDraft, "sequence">;
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
    };

function roleForLine(line: string): ScratchMessageRole {
  return line.startsWith("[tool]") ? "tool" : "assistant";
}

export function projectSupervisorEventToScratch(
  event: MinimalSupervisorEvent,
): ScratchSupervisorEventProjection {
  const supervisorEventId = String(event.monotonicId);

  switch (event.type) {
    case "session.line":
      return {
        message: {
          role: roleForLine(event.line),
          content: event.line,
          supervisorEventId,
        },
      };
    case "session.update":
      return {
        message: {
          role: "system",
          content: JSON.stringify(event.update),
          supervisorEventId,
        },
      };
    case "session.permission_request":
      return {
        dialogStatus: "NeedsInput",
        hitlRequestId: event.requestId,
        message: {
          role: "system",
          content: "Permission request",
          supervisorEventId,
        },
      };
    case "session.exited":
      return {
        dialogStatus:
          event.reason === "intentional" ? "Review" : "WaitingForUser",
      };
    case "session.crashed":
      return { dialogStatus: "Crashed" };
  }
}

async function appendProjectedMessage(args: {
  db: DbClientLike;
  runId: string;
  message: Omit<ScratchMessageDraft, "sequence">;
}): Promise<void> {
  const sequenceRows: Array<{ sequence: number }> = await args.db
    .select({ sequence: scratchMessages.sequence })
    .from(scratchMessages)
    .where(eq(scratchMessages.runId, args.runId));
  const sequence = nextScratchMessageSequence(
    sequenceRows.map((row) => row.sequence),
  );

  await args.db.insert(scratchMessages).values({
    id: randomUUID(),
    runId: args.runId,
    sequence,
    role: args.message.role,
    content: args.message.content,
    supervisorEventId: args.message.supervisorEventId ?? null,
    createdAt: new Date(),
  });
}

async function applyDialogStatus(args: {
  db: DbClientLike;
  runId: string;
  dialogStatus: ScratchDialogStatus;
}): Promise<void> {
  const now = new Date();

  await args.db
    .update(scratchRuns)
    .set({ dialogStatus: args.dialogStatus, updatedAt: now })
    .where(eq(scratchRuns.runId, args.runId));
  await args.db
    .update(runs)
    .set({ status: runStatusForDialogStatus(args.dialogStatus) })
    .where(eq(runs.id, args.runId));
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
        prompt: permissionPrompt(args.event),
      });
      await applyDialogStatus({
        db: tx,
        runId: args.runId,
        dialogStatus: "NeedsInput",
      });
      await appendProjectedMessage({
        db: tx,
        runId: args.runId,
        message: {
          role: "system",
          content: "Permission request",
          supervisorEventId: String(args.event.monotonicId),
        },
      });
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

function startScratchEventConsumer(args: {
  db: DbClientLike;
  runId: string;
  stepId: string;
  sessionId: string;
  api: ScratchSupervisorApi;
}) {
  const abort = new AbortController();
  const pendingWork: Promise<void>[] = [];
  let permissionPersistFailure: { reason: string } | null = null;

  const done = (async () => {
    try {
      for await (const event of args.api.streamSession(args.sessionId, {
        signal: abort.signal,
      })) {
        if (event.type === "session.permission_request") {
          pendingWork.push(
            persistPermissionRequest({
              db: args.db,
              runId: args.runId,
              stepId: args.stepId,
              sessionId: args.sessionId,
              event,
              api: args.api,
            }).catch((err) => {
              if (!permissionPersistFailure) {
                permissionPersistFailure = {
                  reason: err instanceof Error ? err.message : String(err),
                };
              }
            }),
          );
          continue;
        }

        const projection = projectSupervisorEventToScratch(event);

        if (projection.dialogStatus) {
          pendingWork.push(
            applyDialogStatus({
              db: args.db,
              runId: args.runId,
              dialogStatus: projection.dialogStatus,
            }),
          );
        }
        if (projection.message) {
          pendingWork.push(
            appendProjectedMessage({
              db: args.db,
              runId: args.runId,
              message: projection.message,
            }),
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
    } finally {
      await Promise.allSettled(pendingWork);
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
