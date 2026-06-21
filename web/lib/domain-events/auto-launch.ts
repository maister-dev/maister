import "server-only";

import type { DomainEventRow, TaskDelegationSpec } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";

import { and, eq, ne } from "drizzle-orm";
import pino from "pino";

import { launchAgentRun, type LaunchAgentRunResult } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isRunSettledEventKind } from "@/lib/domain-events/taxonomy";
import { isMaisterError } from "@/lib/errors";
import {
  promoteChildRunForToken,
  type PromoteRunResult,
} from "@/lib/runs/promote";
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

type PromoteFn = (
  childRunId: string,
  opts: Parameters<typeof promoteChildRunForToken>[1],
) => Promise<PromoteRunResult>;

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

// M37 (ADR-100): an as-plan (launch_mode='auto') child reaching Review is
// auto-promoted (system actor, local_merge) so the auto-DAG flows without a live
// coordinator. The promote flips the child Done → emits run.done → this consumer
// (on that event) advances the task + releases dependents. Only as-plan children
// auto-promote; a manual (as-run) child is the live coordinator's to promote via
// run_promote. Idempotent: the promote Review→Done CAS no-ops a redelivered
// window; a merge CONFLICT leaves the child in Review (logged — the dependent
// stays blocked for a human to resolve, no auto-resolve, §8).
async function autoPromoteAsPlanChild(
  db: Db,
  event: DomainEventRow,
  promote: PromoteFn,
): Promise<void> {
  if (typeof event.runId !== "string" || event.runId.length === 0) return;

  const rows = await db
    .select({
      launchMode: runs.launchMode,
      projectId: runs.projectId,
      status: runs.status,
      rootRunId: runs.rootRunId,
    })
    .from(runs)
    .where(eq(runs.id, event.runId));
  const child = rows[0];

  // Only an as-plan child still in Review is a candidate.
  if (!child || child.launchMode !== "auto" || child.status !== "Review") {
    return;
  }

  try {
    await promote(event.runId, {
      projectId: child.projectId,
      actor: { kind: "system" },
      db,
    });
    log.info(
      { eventId: event.id, childRunId: event.runId },
      "auto-launch: as-plan child auto-promoted on Review",
    );
  } catch (err) {
    // T13 (ADR-101): the promote-time settled-gate (T9) refuses a shared-tree
    // promote with PRECONDITION while ANY shared sibling is still writable. That
    // is the BENIGN "not yet — wait for the last sibling" path: the LAST
    // sibling's run.review drives the single tree-promote. Log it distinctly (a
    // debug, not a warn) so it never reads as a real failure; every other
    // refusal stays a warn.
    if (
      isMaisterError(err) &&
      err.code === "PRECONDITION" &&
      err.message.startsWith("shared-tree promote blocked")
    ) {
      log.debug(
        {
          childRunId: event.runId,
          rootRunId: child.rootRunId ?? null,
          reason: "shared-tree not settled",
        },
        "auto-launch: shared-tree not settled — waiting for the last sibling",
      );

      return;
    }

    log.warn(
      {
        eventId: event.id,
        childRunId: event.runId,
        code: isMaisterError(err) ? err.code : "UNKNOWN",
        err: err instanceof Error ? err.message : String(err),
      },
      "auto-launch: as-plan child auto-promote refused — left in Review",
    );
  }
}

// The auto_launch_run_plan outbox consumer (ADR-098): a child terminal event
// releases the orchestrator's as-plan siblings whose success-gated `requires`
// blockers have all cleared. The dispatcher is a singleton
// (pg_advisory_xact_lock), so the only race is at-least-once REDELIVERY —
// made idempotent by the per-task hasAnyRun guard (an auto-DAG task launches
// exactly once over its lifetime). A redelivered window re-runs handle, sees
// the already-created run, and skips.
export function buildAutoLaunchRunPlanConsumer(
  opts: { db?: Db; launch?: LaunchFn; promote?: PromoteFn } = {},
): DomainEventConsumer {
  return {
    id: "auto_launch_run_plan",
    startFrom: "now",
    async handle(events: DomainEventRow[]): Promise<void> {
      const _db = opts.db ?? getDb();
      const launch = opts.launch ?? launchAgentRun;
      const promote = opts.promote ?? promoteChildRunForToken;

      for (const event of events) {
        // React to the SETTLED set (terminal kinds + run.review).
        if (!isRunSettledEventKind(event.kind)) continue;

        const payload = (event.payload ?? {}) as Record<string, unknown>;

        // Branch on run_kind FIRST (skill-context rule 207): only an agent
        // child settled event carries an orchestrator parent_run_id.
        if (payload.runKind !== "agent") continue;

        const parentRunId = payload.parentRunId;

        if (typeof parentRunId !== "string" || parentRunId.length === 0) {
          continue;
        }

        // M37 (ADR-100): an as-plan child reaching Review auto-promotes; the
        // resulting run.done re-enters this consumer to advance the task +
        // release dependents. Manual (as-run) children are skipped here — the
        // live coordinator promotes them via run_promote.
        if (event.kind === "run.review") {
          await autoPromoteAsPlanChild(_db, event, promote);
          continue;
        }

        // M37 (ADR-098): a SUCCESSFUL as-plan child advances its OWN task to Done
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
              // M37 (ADR-100): honor the plan task's declared workspace axis.
              workspace: spec.workspace ?? null,
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
