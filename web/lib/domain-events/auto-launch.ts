import "server-only";

import type { DomainEventRow, TaskDelegationSpec } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";

import { and, eq, ne } from "drizzle-orm";
import pino from "pino";

import { launchAgentRun, type LaunchAgentRunResult } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isRunTerminalEventKind } from "@/lib/domain-events/taxonomy";
import { isMaisterError } from "@/lib/errors";
import { getOpenRelationBlockers } from "@/lib/social/relations";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, taskRelations, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "auto-launch-run-plan",
  level: process.env.LOG_LEVEL ?? "info",
});

type LaunchFn = (
  input: Parameters<typeof launchAgentRun>[0],
) => Promise<LaunchAgentRunResult>;

type CandidateRow = {
  taskId: string;
  projectId: string;
  delegationSpec: TaskDelegationSpec | null;
};

// True when the as-plan task already has ANY run (live OR terminal). An auto-DAG
// task launches exactly once over its lifetime, so a run of any status means
// the auto-launcher must not spawn another. This is the exactly-once belt
// (the (agent_id, trigger_event_id) unique index is the suspenders): it stops a
// LATER sibling's terminal event from re-launching a dependent an earlier event
// already launched, AND keeps the just-terminated source sibling (re-discovered
// as a parent_of candidate) from being relaunched.
async function hasAnyRun(db: Db, taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .limit(1);

  return rows.length > 0;
}

// The auto_launch_run_plan outbox consumer (ADR-095): a child terminal event
// releases the orchestrator's as-plan siblings whose success-gated `requires`
// blockers have all cleared. The dispatcher is a singleton
// (pg_advisory_xact_lock), so the only race is at-least-once REDELIVERY —
// made idempotent by the per-task hasAnyRun guard (an auto-DAG task launches
// exactly once over its lifetime). A redelivered window re-runs handle, sees
// the already-created run, and skips.
export function buildAutoLaunchRunPlanConsumer(
  opts: { db?: Db; launch?: LaunchFn } = {},
): DomainEventConsumer {
  return {
    id: "auto_launch_run_plan",
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const _db = opts.db ?? getDb();
      const launch = opts.launch ?? launchAgentRun;

      for (const event of events) {
        if (!isRunTerminalEventKind(event.kind)) continue;

        const payload = (event.payload ?? {}) as Record<string, unknown>;

        // Branch on run_kind FIRST (skill-context rule 207): only an agent
        // child terminal carries an orchestrator parent_run_id.
        if (payload.runKind !== "agent") continue;

        const parentRunId = payload.parentRunId;

        if (typeof parentRunId !== "string" || parentRunId.length === 0) {
          continue;
        }

        // M36 (ADR-095): a SUCCESSFUL as-plan child advances its OWN task to Done
        // — the `requires` success-gate releases a dependent only when its
        // dependency task is Done. A failed/crashed/abandoned child leaves its
        // task non-Done, so the gate keeps dependents blocked and the
        // orchestrator is woken to handle it (Phase 5). Gated to as-plan tasks
        // (launch_mode='auto') so normal task lifecycles are untouched. Runs
        // BEFORE discovery so a dependent released by THIS terminal launches now.
        if (event.kind === "run.done" && typeof event.taskId === "string") {
          await _db
            .update(tasks)
            .set({ status: "Done", updatedAt: new Date() })
            .where(
              and(
                eq(tasks.id, event.taskId),
                eq(tasks.launchMode, "auto"),
                ne(tasks.status, "Done"),
              ),
            );
        }

        // Load the orchestrator parent run to get its task + tree root.
        const parentRows = await _db
          .select({
            id: runs.id,
            taskId: runs.taskId,
            rootRunId: runs.rootRunId,
          })
          .from(runs)
          .where(eq(runs.id, parentRunId));
        const parent = parentRows[0];

        if (!parent) {
          log.debug(
            { eventId: event.id, parentRunId },
            "auto-launch: orchestrator parent run not found — skip",
          );
          continue;
        }

        // A plan's tasks are linked parent_of UNDER the orchestrator's task. A
        // task-less orchestrator has no as-plan siblings to discover.
        if (!parent.taskId) continue;

        const rootRunId = parent.rootRunId ?? parent.id;

        // Discover candidate sibling tasks: parent_of FROM the orchestrator's
        // task, joined to as-plan (launch_mode='auto') tasks.
        const candidates: CandidateRow[] = await _db
          .select({
            taskId: tasks.id,
            projectId: tasks.projectId,
            delegationSpec: tasks.delegationSpec,
          })
          .from(taskRelations)
          .innerJoin(tasks, eq(taskRelations.toTaskId, tasks.id))
          .where(
            and(
              eq(taskRelations.kind, "parent_of"),
              eq(taskRelations.fromTaskId, parent.taskId),
              eq(tasks.launchMode, "auto"),
            ),
          );

        for (const candidate of candidates) {
          try {
            const spec = candidate.delegationSpec;

            if (!spec || !spec.agentId) {
              log.warn(
                { eventId: event.id, taskId: candidate.taskId },
                "auto-launch: as-plan task has no delegation_spec.agentId — skip",
              );
              continue;
            }

            // Skip if the task already launched (any run) — exactly-once belt.
            // Also excludes the just-terminated source sibling re-discovered
            // here as a parent_of candidate.
            if (await hasAnyRun(_db, candidate.taskId)) continue;

            // Skip while any `requires` blocker is unsatisfied. The success-gate
            // keeps a Failed/Abandoned dependency blocking, so a dependent only
            // releases on a SUCCESSFUL dependency.
            const blockers = await getOpenRelationBlockers(
              [candidate.taskId],
              _db,
            );

            if ((blockers.get(candidate.taskId) ?? []).length > 0) continue;

            // trigger.eventId is intentionally NOT the domain-event id: ONE
            // terminal event can release MULTIPLE same-agent dependents (a
            // fan-out like A→{B,C} in a diamond), and the (agent_id,
            // trigger_event_id) unique index would collapse them to one run,
            // starving the rest. Idempotency is the hasAnyRun guard above plus
            // the singleton dispatcher's commit-before-cursor-advance: a
            // redelivered window re-runs handle, sees the run, and skips.
            const result = await launch({
              agentId: spec.agentId,
              projectId: candidate.projectId,
              taskId: candidate.taskId,
              launchOverrideRunnerId: spec.runnerOverride ?? null,
              parentRunId,
              rootRunId,
              launchMode: "auto",
              trigger: { source: "domain_event", eventId: null },
              db: _db,
            });

            if ("deduped" in result) {
              log.debug(
                { eventId: event.id, taskId: candidate.taskId },
                "auto-launch: trigger already claimed — dedup",
              );
            } else {
              log.info(
                {
                  eventId: event.id,
                  taskId: candidate.taskId,
                  agentId: spec.agentId,
                  runId: result.runId,
                  status: result.status,
                },
                "auto-launch: as-plan dependent launched",
              );
            }
          } catch (err) {
            // Idempotent contract: one bad task is logged, never thrown — a
            // throw would redeliver (and re-attempt) the whole window forever.
            log.warn(
              {
                eventId: event.id,
                taskId: candidate.taskId,
                code: isMaisterError(err) ? err.code : "UNKNOWN",
                err: err instanceof Error ? err.message : String(err),
              },
              "auto-launch: candidate launch refused",
            );
          }
        }
      }
    },
  };
}

export const autoLaunchRunPlanConsumer = buildAutoLaunchRunPlanConsumer();
