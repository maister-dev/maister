import "server-only";

import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { DomainEventRow } from "@/lib/db/schema";
import type { LaunchRunContext, LaunchRunInput } from "@/lib/services/runs";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { ralphMaxAttempts } from "@/lib/instance-config";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import { crashRetryFromSnapshot } from "@/lib/runs/execution-policy";
import { launchRun } from "@/lib/services/runs";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, tasks } = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "ralph-loop",
  level: process.env.LOG_LEVEL ?? "info",
});

type LaunchFn = (
  input: LaunchRunInput,
  ctx: LaunchRunContext,
  db?: Db,
) => Promise<{ runId: string; status: string; queuePosition?: number }>;

// Execution-policy axis A2 (ralph_loop): the run.failed outbox consumer
// auto-relaunches a fresh attempt against the same task when the failed run's
// SNAPSHOTTED policy resolves crashRetry to ralph_loop, bounded by
// MAISTER_RALPH_MAX_ATTEMPTS total attempts (original launch + relaunches). On
// the cap the task is left to hold in Backlog for a human.
//
// Only `unattended` resolves crashRetry to ralph_loop (preset table);
// assisted/supervised stay `fail`, so they never relaunch. Acting on the run's
// own snapshot (not a re-resolved default) keeps a launch override honored and
// carries the policy forward onto the new attempt.
//
// Idempotent across at-least-once redelivery WITHOUT a new column: a relaunch
// bumps tasks.attempt_number in the launch tx, so a redelivered older failure
// (attemptNumber !== the task's current attempt) is a no-op. Per the consumer
// contract, handle NEVER throws — a throw redelivers the whole window forever.
export function buildRalphLoopConsumer(
  opts: { db?: Db; launch?: LaunchFn; maxAttempts?: () => number } = {},
): DomainEventConsumer {
  return {
    id: "ralph_loop",
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const _db = opts.db ?? getDb();
      const launch = opts.launch ?? launchRun;
      const max = (opts.maxAttempts ?? ralphMaxAttempts)();

      for (const event of events) {
        if (event.kind !== "run.failed" || !event.runId) continue;

        try {
          const runRows = await _db
            .select({
              id: runs.id,
              taskId: runs.taskId,
              runKind: runs.runKind,
              executionPolicy: runs.executionPolicy,
            })
            .from(runs)
            .where(eq(runs.id, event.runId));
          const run = runRows[0];

          // Only task-backed flow runs ralph; scratch/agent runs do not.
          if (!run || run.runKind !== "flow" || !run.taskId) continue;
          if (crashRetryFromSnapshot(run.executionPolicy) !== "ralph_loop") {
            continue;
          }

          const taskRows = await _db
            .select({
              id: tasks.id,
              status: tasks.status,
              attemptNumber: tasks.attemptNumber,
            })
            .from(tasks)
            .where(eq(tasks.id, run.taskId));
          const task = taskRows[0];

          if (!task) continue;
          // Terminal task (explicit discard / merged) → never relaunch.
          if (task.status === "Abandoned" || task.status === "Done") continue;

          // Idempotency + staleness, without a per-run attempt number: only the
          // task's CURRENT latest flow run relaunches (latest = max started_at,
          // board.ts's rule). A relaunch inserts a newer Pending run, so an
          // at-least-once redelivery — or any newer in-flight attempt — sees a
          // different latest run and is a no-op here.
          const latestRows = await _db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.taskId, run.taskId), eq(runs.runKind, "flow")))
            .orderBy(desc(runs.startedAt))
            .limit(1);

          if (latestRows[0]?.id !== run.id) continue;

          // tasks.attempt_number is the high-water mark = this (latest) attempt.
          if (task.attemptNumber >= max) {
            log.info(
              {
                taskId: run.taskId,
                fromRunId: run.id,
                attempt: task.attemptNumber,
                max,
                action: "hold",
              },
              "[ralph] max attempts reached — holding task in Backlog",
            );
            continue;
          }

          const result = await launch(
            {
              taskId: run.taskId,
              executionPolicy: run.executionPolicy ?? undefined,
            },
            // System fire: actorUserId null ⇒ system actor; no-op authorize
            // (the original unattended launch already passed launchUnattended;
            // this relaunch continues that vetted intent — same pattern as the
            // scheduler / run-schedule fires).
            { actorUserId: null, authorize: async () => {} },
            _db,
          );

          logExecPolicyAction({
            runId: run.id,
            kind: "ralph_relaunch",
            detail: {
              taskId: run.taskId,
              fromRunId: run.id,
              fromAttempt: task.attemptNumber,
              max,
              newRunId: result.runId,
              status: result.status,
            },
          });
          log.info(
            {
              taskId: run.taskId,
              fromRunId: run.id,
              attempt: task.attemptNumber,
              max,
              action: "relaunch",
              newRunId: result.runId,
              status: result.status,
            },
            "[ralph] auto-relaunched failed run",
          );
        } catch (err) {
          // Idempotent contract (mirrors agent_triggers): refusals are logged,
          // never thrown — a throw would redeliver the whole window forever.
          log.warn(
            {
              eventId: event.id,
              runId: event.runId,
              code: isMaisterError(err) ? err.code : "UNKNOWN",
              err: err instanceof Error ? err.message : String(err),
            },
            "[ralph] auto-relaunch refused",
          );
        }
      }
    },
  };
}

export const ralphLoopConsumer = buildRalphLoopConsumer();
