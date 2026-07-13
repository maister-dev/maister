import "server-only";

import type { FormSchema } from "@/lib/config.schema";
import type { SupervisorSessionRecord } from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import {
  createHitlAssignment,
  systemCloseActiveAssignmentsForHitlRequest,
} from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import { promoteNextPending } from "@/lib/scheduler";
import { deleteSession, listSessions } from "@/lib/supervisor-client";
import { revokeAgentRunTokensForRun } from "@/lib/agents/tokens";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { hitlRequests, runs, taskClarifications, tasks } =
  schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agent-question",
  level: process.env.LOG_LEVEL ?? "info",
});

const TERMINAL_SOURCE_STATUSES = new Set([
  "Done",
  "Failed",
  "Crashed",
  "Abandoned",
]);

export type AgentQuestionReTriggerMode = "agent" | "triage";

export type CreateAgentQuestionInput = {
  projectId: string;
  taskId: string;
  sourceRunId: string;
  sourceAgentId: string;
  question: string;
  schema: FormSchema;
  reTriggerMode: AgentQuestionReTriggerMode;
};

export type AgentQuestionResult = {
  hitlRequestId: string;
  taskId: string;
  sourceRunId: string;
  activationState: "pending_termination" | "active" | "failed";
  created: boolean;
};

type ActivationDeps = {
  db?: Db;
  listSessions?: () => Promise<SupervisorSessionRecord[]>;
  deleteSession?: (sessionId: string) => Promise<void>;
  recordSuccessAudit?: (tx: Db, statusCode: number) => Promise<void>;
};

type PendingQuestion = {
  id: string;
  taskId: string;
  runId: string;
  activationState: "pending_termination" | "active" | "failed";
  created: boolean;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function sameQuestionPayload(
  row: { prompt: string; schema: unknown; reTriggerMode: string | null },
  input: CreateAgentQuestionInput,
): boolean {
  return (
    row.prompt === input.question &&
    row.reTriggerMode === input.reTriggerMode &&
    stableJson(row.schema) === stableJson(input.schema)
  );
}

async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (typeof db.transaction !== "function") return await fn(db);

  return await db.transaction(fn);
}

async function persistPendingQuestion(
  input: CreateAgentQuestionInput,
  db: Db,
): Promise<PendingQuestion> {
  return await inTransaction(db, async (tx) => {
    const taskRows = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)))
      .for("update");

    if (!taskRows[0]) {
      throw new MaisterError("PRECONDITION", "task not found for human ask");
    }

    const sourceRows = await tx
      .select({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        agentId: runs.agentId,
        runKind: runs.runKind,
        status: runs.status,
      })
      .from(runs)
      .where(eq(runs.id, input.sourceRunId))
      .for("update");
    const source = sourceRows[0];

    if (
      !source ||
      source.projectId !== input.projectId ||
      source.taskId !== input.taskId ||
      source.agentId !== input.sourceAgentId ||
      source.runKind !== "agent"
    ) {
      throw new MaisterError("PRECONDITION", "bound agent run is not eligible");
    }

    const existingRows = await tx
      .select({
        id: hitlRequests.id,
        prompt: hitlRequests.prompt,
        schema: hitlRequests.schema,
        reTriggerMode: hitlRequests.reTriggerMode,
        activationState: hitlRequests.activationState,
        supersededAt: hitlRequests.supersededAt,
      })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, input.sourceRunId),
          eq(hitlRequests.kind, "agent_question"),
        ),
      )
      .for("update");
    const existing = existingRows[0];

    if (existing) {
      if (
        existing.supersededAt === null &&
        sameQuestionPayload(existing, input) &&
        existing.activationState !== "failed"
      ) {
        return {
          id: existing.id,
          taskId: input.taskId,
          runId: input.sourceRunId,
          activationState: existing.activationState as PendingQuestion["activationState"],
          created: false,
        };
      }

      throw new MaisterError(
        "CONFLICT",
        "source agent already has a different or terminal human ask",
      );
    }

    if (source.status !== "Running") {
      throw new MaisterError(
        "PRECONDITION",
        "agent run is not Running for human ask",
      );
    }

    if (input.reTriggerMode === "triage" && input.sourceAgentId !== "core:triager") {
      throw new MaisterError(
        "UNAUTHORIZED",
        "triage re-trigger is restricted to the core triager",
      );
    }

    const sequenceRows = await tx
      .select({ maxSeq: sql<number>`coalesce(max(${taskClarifications.seq}), 0)` })
      .from(taskClarifications)
      .where(eq(taskClarifications.taskId, input.taskId));
    const nextSequence = Number(sequenceRows[0]?.maxSeq ?? 0) + 1;
    const hitlRequestId = randomUUID();

    await tx.insert(hitlRequests).values({
      id: hitlRequestId,
      runId: input.sourceRunId,
      stepId: "agent",
      kind: "agent_question",
      taskId: input.taskId,
      activationState: "pending_termination",
      reTriggerMode: input.reTriggerMode,
      schema: input.schema,
      prompt: input.question,
    });
    await tx.insert(taskClarifications).values({
      id: randomUUID(),
      taskId: input.taskId,
      seq: nextSequence,
      sourceHitlRequestId: hitlRequestId,
      originRunId: input.sourceRunId,
      originAgentId: input.sourceAgentId,
      question: input.question,
      questionSchema: input.schema,
      reTriggerMode: input.reTriggerMode,
    });

    log.info(
      {
        hitlRequestId,
        taskId: input.taskId,
        sourceRunId: input.sourceRunId,
        sourceAgentId: input.sourceAgentId,
        activationState: "pending_termination",
        schemaVersion: input.schema.schemaVersion,
        fieldCount: input.schema.fields.length,
      },
      "agent human ask persisted pending source termination",
    );

    return {
      id: hitlRequestId,
      taskId: input.taskId,
      runId: input.sourceRunId,
      activationState: "pending_termination",
      created: true,
    };
  });
}

async function terminateSourceSession(
  sourceRunId: string,
  db: Db,
  deps: Required<Pick<ActivationDeps, "listSessions" | "deleteSession">>,
): Promise<"terminated" | "gone" | "pending"> {
  const activeSession = await loadActiveRunSession(db, sourceRunId);

  if (!activeSession?.acpSessionId) return "pending";

  const sessions = await deps.listSessions();
  const live = sessions.find(
    (session) =>
      session.runId === sourceRunId &&
      session.status === "live" &&
      session.acpSessionId === activeSession.acpSessionId,
  );

  if (!live) return "gone";

  await deps.deleteSession(live.sessionId);

  return "terminated";
}

async function markActivationFailed(
  db: Db,
  hitlRequestId: string,
): Promise<void> {
  await inTransaction(db, async (tx) => {
    await tx
      .update(hitlRequests)
      .set({ activationState: "failed" })
      .where(
        and(
          eq(hitlRequests.id, hitlRequestId),
          eq(hitlRequests.activationState, "pending_termination"),
        ),
      );
  });
}

async function activatePendingQuestion(
  pending: PendingQuestion,
  db: Db,
  recordSuccessAudit: ActivationDeps["recordSuccessAudit"],
  statusCode: number,
): Promise<"active" | "replayed" | "pending"> {
  return await inTransaction(db, async (tx) => {
    const rows = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, pending.id))
      .for("update");
    const question = rows[0];

    if (!question || question.kind !== "agent_question") {
      throw new MaisterError("PRECONDITION", "human ask disappeared before activation");
    }
    if (question.activationState === "active") return "replayed";
    if (question.activationState === "failed" || question.supersededAt !== null) {
      throw new MaisterError("CONFLICT", "human ask cannot be activated");
    }

    const sourceRows = await tx
      .select({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        status: runs.status,
        runKind: runs.runKind,
      })
      .from(runs)
      .where(eq(runs.id, pending.runId))
      .for("update");
    const source = sourceRows[0];

    if (
      !source ||
      source.runKind !== "agent" ||
      source.projectId === null ||
      source.taskId !== pending.taskId
    ) {
      throw new MaisterError("PRECONDITION", "source run cannot activate human ask");
    }

    if (source.status === "Running") {
      await tx
        .update(runs)
        .set({ status: "Done", endedAt: new Date(), currentStepId: null })
        .where(and(eq(runs.id, pending.runId), eq(runs.status, "Running")));
      await revokeAgentRunTokensForRun(pending.runId, tx);
    } else if (!TERMINAL_SOURCE_STATUSES.has(source.status)) {
      return "pending";
    }

    await tx
      .update(hitlRequests)
      .set({ activationState: "active" })
      .where(
        and(
          eq(hitlRequests.id, pending.id),
          eq(hitlRequests.activationState, "pending_termination"),
        ),
      );
    await createHitlAssignment({
      db: tx,
      projectId: source.projectId,
      runId: pending.runId,
      taskId: pending.taskId,
      stepId: "agent",
      hitlRequestId: pending.id,
      actionKind: "agent_question",
      title: "Agent clarification required",
    });

    if (recordSuccessAudit) await recordSuccessAudit(tx, statusCode);

    log.info(
      {
        hitlRequestId: pending.id,
        taskId: pending.taskId,
        sourceRunId: pending.runId,
        activationState: "active",
      },
      "agent human ask activated and source run finalized",
    );

    return "active";
  });
}

export async function createOrActivateAgentQuestion(
  input: CreateAgentQuestionInput,
  deps: ActivationDeps = {},
): Promise<AgentQuestionResult> {
  const db = deps.db ?? getDb();
  const pending = await persistPendingQuestion(input, db);

  if (pending.activationState === "active") {
    return {
      hitlRequestId: pending.id,
      taskId: pending.taskId,
      sourceRunId: pending.runId,
      activationState: "active",
      created: false,
    };
  }

  const terminate = await terminateSourceSession(pending.runId, db, {
    listSessions: deps.listSessions ?? listSessions,
    deleteSession: deps.deleteSession ?? deleteSession,
  }).catch(async (error: unknown) => {
    if (isMaisterError(error) && error.code === "EXECUTOR_UNAVAILABLE") {
      log.warn(
        { hitlRequestId: pending.id, sourceRunId: pending.runId, code: error.code },
        "agent human ask termination remains pending after retryable supervisor failure",
      );
      throw error;
    }

    await markActivationFailed(db, pending.id);
    throw new MaisterError(
      "CONFLICT",
      "source supervisor session could not be terminated",
    );
  });

  if (terminate === "pending") {
    return {
      hitlRequestId: pending.id,
      taskId: pending.taskId,
      sourceRunId: pending.runId,
      activationState: "pending_termination",
      created: pending.created,
    };
  }

  const activation = await activatePendingQuestion(
    pending,
    db,
    deps.recordSuccessAudit,
    pending.created ? 201 : 200,
  );

  if (activation === "pending") {
    return {
      hitlRequestId: pending.id,
      taskId: pending.taskId,
      sourceRunId: pending.runId,
      activationState: "pending_termination",
      created: pending.created,
    };
  }

  if (activation === "active") {
    await promoteNextPending({ db, pool: "agent" });
  }

  return {
    hitlRequestId: pending.id,
    taskId: pending.taskId,
    sourceRunId: pending.runId,
    activationState: "active",
    created: pending.created && activation === "active",
  };
}

export async function cancelOpenAgentQuestionsForTask(args: {
  db?: Db;
  taskId: string;
  supersedingRunId: string;
}): Promise<number> {
  const db = args.db ?? getDb();

  return await inTransaction(db, async (tx) => {
    const taskRows = await tx
      .select({ id: tasks.id, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, args.taskId))
      .for("update");
    const task = taskRows[0];

    if (!task) return 0;

    const openRows = await tx
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.taskId, args.taskId),
          eq(hitlRequests.kind, "agent_question"),
          isNull(hitlRequests.respondedAt),
          isNull(hitlRequests.supersededAt),
          inArray(hitlRequests.activationState, ["pending_termination", "active"]),
        ),
      )
      .for("update");
    const ids = openRows.map((row: { id: string }) => row.id);

    if (ids.length === 0) {
      log.debug(
        { taskId: args.taskId, supersedingRunId: args.supersedingRunId },
        "no open agent questions to supersede",
      );
      return 0;
    }

    const supersededAt = new Date();
    await tx
      .update(hitlRequests)
      .set({ supersededAt, supersededByRunId: args.supersedingRunId })
      .where(inArray(hitlRequests.id, ids));
    await tx
      .update(taskClarifications)
      .set({ supersededAt, supersededByRunId: args.supersedingRunId })
      .where(inArray(taskClarifications.sourceHitlRequestId, ids));

    for (const hitlRequestId of ids) {
      await systemCloseActiveAssignmentsForHitlRequest({
        db: tx,
        hitlRequestId,
        projectId: task.projectId,
        reason: "superseded by a newer task-bound agent run",
      });
    }

    log.info(
      { taskId: args.taskId, supersedingRunId: args.supersedingRunId, count: ids.length },
      "open agent questions superseded by successor run",
    );

    return ids.length;
  });
}

export async function recoverPendingAgentQuestions(args: {
  db?: Db;
  sessions: readonly SupervisorSessionRecord[];
  deleteSession?: (sessionId: string) => Promise<void>;
}): Promise<number> {
  const db = args.db ?? getDb();
  const rows = await db
    .select({
      id: hitlRequests.id,
      taskId: hitlRequests.taskId,
      runId: hitlRequests.runId,
    })
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.kind, "agent_question"),
        eq(hitlRequests.activationState, "pending_termination"),
        isNull(hitlRequests.respondedAt),
        isNull(hitlRequests.supersededAt),
      ),
    )
    .limit(100);
  let activated = 0;

  for (const row of rows) {
    if (!row.taskId) continue;
    const pending: PendingQuestion = {
      id: row.id,
      taskId: row.taskId,
      runId: row.runId,
      activationState: "pending_termination",
      created: false,
    };
    try {
      const [source] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, row.runId));

      if (!source) continue;

      if (!TERMINAL_SOURCE_STATUSES.has(source.status)) {
        const activeSession = await loadActiveRunSession(db, row.runId);
        const live = activeSession?.acpSessionId
          ? args.sessions.find(
              (session) =>
                session.runId === row.runId &&
                session.status === "live" &&
                session.acpSessionId === activeSession.acpSessionId,
            )
          : undefined;

        if (!activeSession?.acpSessionId) continue;
        if (live) {
          await (args.deleteSession ?? deleteSession)(live.sessionId);
        }
      }

      const result = await activatePendingQuestion(pending, db, undefined, 200);

      if (result === "active") {
        activated += 1;
        await promoteNextPending({ db, pool: "agent" });
      }
    } catch (error) {
      log.warn(
        {
          hitlRequestId: row.id,
          sourceRunId: row.runId,
          code: isMaisterError(error) ? error.code : undefined,
        },
        "pending agent human ask recovery deferred after retryable failure",
      );
    }
  }

  if (activated > 0) {
    log.info({ activated }, "pending agent human asks recovered");
  }

  return activated;
}
