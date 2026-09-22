import "server-only";

import { randomUUID } from "node:crypto";

import pino from "pino";

import { isMaisterError } from "@/lib/errors";
import {
  schedulerTickFinished,
  schedulerTickStarted,
  type SchedulerTickSource,
} from "@/lib/scheduler/clock-health";
import { upgradeMaintenanceEngaged } from "@/lib/maintenance/upgrade-fence";
import {
  claimDueJobs,
  DEFAULT_SYSTEM_SWEEP_JOB_ID,
  ensureDefaultSchedulerJobs,
  loadPreviousSchedulerAttempt,
  reapStuckSchedulerAttempts,
  recordJobAttemptResult,
  recordJobAttemptStarted,
  renewSchedulerJobAttemptLease,
  requestSchedulerJobNow,
  schedulerAttemptTimeoutSeconds,
  type ClaimedSchedulerJob,
  type SchedulerJobKind,
} from "@/lib/scheduler/jobs";
import { runEvaluationDispatchTick } from "@/lib/evaluations/dispatcher/tick";
import { runEvaluationSuiteScanTick } from "@/lib/evaluations/suites";
import { dispatchDueSchedules } from "@/lib/run-schedules/dispatch";
import { dispatchDueScheduledLaunches } from "@/lib/scheduled-launches/dispatch";
import { runAgentTickJob } from "@/lib/scheduler/handlers/agent-tick";
import { runAutoLaunchTriagedJob } from "@/lib/scheduler/handlers/auto-launch-triaged";
import { runAutoPromoteJob } from "@/lib/scheduler/handlers/auto-promote";
import { runCommandJob } from "@/lib/scheduler/handlers/command";
import { runDomainEventDispatchJob } from "@/lib/scheduler/handlers/domain-event-dispatch";
import { runScheduledFlowJob } from "@/lib/scheduler/handlers/flow-run";
import { runPrStateScanJob } from "@/lib/scheduler/handlers/pr-state-scan";
import { runRepoDeliveryScanJob } from "@/lib/scheduler/handlers/repo-delivery-scan";
import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";
import { runSystemSweep } from "@/lib/scheduler/system-sweeps";
import {
  parseExecutionObservability,
  type ExecutionObservabilitySummary,
  type LagStreamObservation,
} from "@/lib/execution-host/events/lag-observation";

export type SchedulerTickSummary = {
  attemptedCount: number;
  claimedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  attempts: SchedulerTickJobSummary[];
};

export type SchedulerTickJobSummary = {
  jobId: string;
  attemptId: string;
  jobKind: SchedulerJobKind;
  status: "Succeeded" | "Failed" | "Skipped";
  errorCode?: string;
  errorMessage?: string;
};

type RunSchedulerTickInput = {
  jobKind?: SchedulerJobKind;
  source?: SchedulerTickSource;
};

const log = pino({
  name: "scheduler-tick",
  level: process.env.LOG_LEVEL ?? "info",
});
const SCHEDULER_OBSERVER_ID = `scheduler:${process.pid}:${randomUUID()}`;

class SchedulerLeaseLostError extends Error {
  constructor(job: ClaimedSchedulerJob) {
    super(`scheduler lease lost for ${job.jobKind} attempt ${job.attemptId}`);
    this.name = "SchedulerLeaseLostError";
  }
}

class SystemSweepFailedError extends Error {
  readonly summary: Awaited<ReturnType<typeof runSystemSweep>>;

  constructor(summary: Awaited<ReturnType<typeof runSystemSweep>>) {
    super(summary.bundleErrors.join("; "));
    this.name = "SystemSweepFailedError";
    this.summary = summary;
  }
}

export async function runSchedulerTick(
  input: RunSchedulerTickInput = {},
): Promise<SchedulerTickSummary> {
  const invocation = schedulerTickStarted(input.source ?? "manual");

  try {
    const result = await runSchedulerTickInternal(input);
    const outcome = result.maintenanceNoop
      ? "maintenance_noop"
      : result.summary.failedCount > 0 || result.summary.skippedCount > 0
        ? "partial"
        : "completed";

    schedulerTickFinished(invocation, outcome);

    return result.summary;
  } catch (err) {
    schedulerTickFinished(invocation, "failed");
    throw err;
  }
}

async function runSchedulerTickInternal(
  input: RunSchedulerTickInput,
): Promise<{ summary: SchedulerTickSummary; maintenanceNoop: boolean }> {
  // D9 step 2: the clock is the entry point for cron launches, agent ticks and
  // the destructive sweep, so a fenced installation claims no job at all. The
  // poller keeps returning a summary — a throw on every tick would bury the
  // operator's own drain output in noise.
  if (upgradeMaintenanceEngaged()) {
    log.info(
      { jobKind: input.jobKind, reason: "upgrade_maintenance_fence" },
      "scheduler tick fenced by upgrade maintenance",
    );

    return {
      maintenanceNoop: true,
      summary: {
        attemptedCount: 0,
        claimedCount: 0,
        succeededCount: 0,
        failedCount: 0,
        skippedCount: 0,
        attempts: [],
      },
    };
  }

  const now = new Date();

  await ensureDefaultSchedulerJobs({ now });
  await reapStuckSchedulerAttempts({ now });

  const claimedJobs = await claimDueJobs({ now, jobKind: input.jobKind });
  const attempts: SchedulerTickJobSummary[] = [];

  for (const job of claimedJobs) {
    attempts.push(await runClaimedJob(job));
  }

  const summary = {
    attemptedCount: attempts.length,
    claimedCount: claimedJobs.length,
    succeededCount: attempts.filter((job) => job.status === "Succeeded").length,
    failedCount: attempts.filter((job) => job.status === "Failed").length,
    skippedCount: attempts.filter((job) => job.status === "Skipped").length,
    attempts,
  };

  log.info({ ...summary, jobKind: input.jobKind }, "scheduler tick completed");

  return { summary, maintenanceNoop: false };
}

/**
 * Requests the canonical system sweep through the durable scheduler claim.
 * Callers receive the scheduler attempt rather than invoking cleanup services
 * outside their lease and summary persistence boundary.
 */
export async function requestSystemSweep(): Promise<SchedulerTickSummary> {
  const now = new Date();

  await ensureDefaultSchedulerJobs({ now });
  await requestSchedulerJobNow({
    jobId: DEFAULT_SYSTEM_SWEEP_JOB_ID,
    now,
  });

  return runSchedulerTick({ jobKind: "system_sweep", source: "cron" });
}

async function runClaimedJob(
  job: ClaimedSchedulerJob,
): Promise<SchedulerTickJobSummary> {
  const started = await recordJobAttemptStarted({ attemptId: job.attemptId });

  if (!started) return leaseLost(job);

  try {
    switch (job.jobKind) {
      case "system_sweep": {
        const previous = await loadPreviousSchedulerAttempt({
          jobId: job.id,
          currentAttemptId: job.attemptId,
        });
        const priorObservation = previousExecutionObservation(previous);
        const systemSweepSummary = await runSystemSweepWithLease(
          job,
          priorObservation,
        );

        if (systemSweepSummary.bundleErrors.length > 0) {
          throw new SystemSweepFailedError(systemSweepSummary);
        }

        const result = await recordSucceeded(job, systemSweepSummary);

        if (result.status === "Succeeded")
          publishExecutionObservationTransition(
            systemSweepSummary.executionObservability,
          );

        return result;
      }
      case "command": {
        await runCommandJob(job.target);

        return recordSucceeded(job);
      }
      case "agent_tick": {
        // M34 (ADR-089): the stub finally gets its launcher — the
        // agent_tick.dispatcher claims due agent_schedules cron rows and
        // recovers stranded Pending agent runs.
        const agentTickSummary = await runAgentTickJob({
          target: job.target,
          launcher: async () => {
            const { dispatchDueAgentSchedules } = await import(
              "@/lib/agents/triggers"
            );

            return dispatchDueAgentSchedules() as Promise<
              Record<string, unknown>
            >;
          },
        });

        return recordSucceeded(job, agentTickSummary);
      }
      case "flow_run": {
        await runScheduledFlowJob(job.target);

        return recordSucceeded(job);
      }
      case "run_schedule": {
        const [recurring, oneTime] = await Promise.all([
          dispatchDueSchedules(),
          dispatchDueScheduledLaunches(),
        ]);
        const dispatchSummary = { recurring, oneTime };

        return recordSucceeded(job, dispatchSummary);
      }
      case "webhook_delivery":
        return recordSucceeded(job, await runWebhookDeliveryJob());
      case "domain_event_dispatch":
        return recordSucceeded(job, await runDomainEventDispatchJob());
      case "auto_launch_triaged":
        return recordSucceeded(job, await runAutoLaunchTriagedJob());
      case "auto_promote":
        return recordSucceeded(job, await runAutoPromoteJob());
      case "repo_delivery_scan":
        return recordSucceeded(
          job,
          await runRepoDeliveryScanJob({ projectId: job.projectId }),
        );
      case "pr_state_scan":
        return recordSucceeded(
          job,
          await runPrStateScanJob({ projectId: job.projectId }),
        );
      case "evaluation_dispatch":
        return recordSucceeded(
          job,
          (await runEvaluationDispatchTick()) as unknown as Record<
            string,
            unknown
          >,
        );
      case "evaluation_suite_scan":
        return recordSucceeded(
          job,
          (await runEvaluationSuiteScanTick()) as unknown as Record<
            string,
            unknown
          >,
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A malformed/missing repository is a project-scoped scanner failure, not
    // a harmless no-op: it must consume that job's bounded retry budget while
    // every other due project remains claimable. Other scheduler PRECONDITION
    // outcomes retain their established skipped semantics.
    const isLeaseLost = err instanceof SchedulerLeaseLostError;
    const isSkip =
      isLeaseLost ||
      (isMaisterError(err) &&
        err.code === "PRECONDITION" &&
        job.jobKind !== "repo_delivery_scan" &&
        job.jobKind !== "pr_state_scan");
    const status = isSkip ? "Skipped" : "Failed";
    const errorCode =
      err instanceof SystemSweepFailedError
        ? "SYSTEM_SWEEP_FAILED"
        : isLeaseLost
          ? "LEASE_LOST"
          : isMaisterError(err)
            ? err.code
            : "SCHEDULER_HANDLER";

    const recorded = await recordJobAttemptResult({
      jobId: job.id,
      attemptId: job.attemptId,
      status,
      errorCode,
      errorMessage: message,
      ...(err instanceof SystemSweepFailedError
        ? { summary: { ...err.summary } }
        : {}),
    });

    if (!recorded) return leaseLost(job);

    if (err instanceof SystemSweepFailedError)
      publishExecutionObservationTransition(err.summary.executionObservability);

    return {
      jobId: job.id,
      attemptId: job.attemptId,
      jobKind: job.jobKind,
      status,
      errorCode,
      errorMessage: message,
    };
  }
}

async function recordSucceeded(
  job: ClaimedSchedulerJob,
  summary?: Record<string, unknown>,
): Promise<SchedulerTickJobSummary> {
  const recorded = await recordJobAttemptResult({
    jobId: job.id,
    attemptId: job.attemptId,
    status: "Succeeded",
    ...(summary ? { summary } : {}),
  });

  return recorded ? succeeded(job) : leaseLost(job);
}

async function runSystemSweepWithLease(
  job: ClaimedSchedulerJob,
  previous: LagStreamObservation | null,
): Promise<Awaited<ReturnType<typeof runSystemSweep>>> {
  let leaseLost = false;
  let renewal: Promise<void> | null = null;
  const renew = async (): Promise<void> => {
    const renewed = await renewSchedulerJobAttemptLease({
      jobId: job.id,
      attemptId: job.attemptId,
    });

    if (renewed) return;

    leaseLost = true;
    log.warn(
      { jobId: job.id, attemptId: job.attemptId },
      "system sweep scheduler lease lost",
    );
  };
  const heartbeat = (): void => {
    if (leaseLost || renewal !== null) return;

    renewal = renew()
      .catch((err: unknown) => {
        leaseLost = true;
        log.warn(
          {
            jobId: job.id,
            attemptId: job.attemptId,
            errorType: err instanceof Error ? err.name : "unknown",
          },
          "system sweep scheduler lease renewal failed",
        );
      })
      .finally(() => {
        renewal = null;
      });
  };

  await renew();
  if (leaseLost) throw new SchedulerLeaseLostError(job);

  const timer = setInterval(
    heartbeat,
    Math.max(250, Math.floor(schedulerAttemptTimeoutSeconds() * 500)),
  );

  timer.unref();

  try {
    const summary = await runSystemSweep({
      executionObservation: {
        attemptId: job.attemptId,
        observerId: SCHEDULER_OBSERVER_ID,
        previous,
      },
    });

    if (renewal !== null) await renewal;
    if (leaseLost) throw new SchedulerLeaseLostError(job);

    await renew();
    if (leaseLost) throw new SchedulerLeaseLostError(job);

    return summary;
  } finally {
    clearInterval(timer);
  }
}

function previousExecutionObservation(
  previous: Awaited<ReturnType<typeof loadPreviousSchedulerAttempt>>,
): LagStreamObservation | null {
  if (
    previous === null ||
    !["Succeeded", "Failed", "Skipped"].includes(previous.status)
  )
    return null;

  return (
    parseExecutionObservability(previous.summary.executionObservability)
      ?.stream ?? null
  );
}

function publishExecutionObservationTransition(
  observation: ExecutionObservabilitySummary | null | undefined,
): void {
  if (observation == null) return;
  const stream = observation.stream;

  if (!stream?.transition) return;

  const fields = {
    attemptId: observation.attemptId,
    observerId: observation.observerId,
    sampledAt: observation.sampledAt,
    executionHostId: stream.identity?.executionHostId ?? null,
    streamId: stream.identity?.streamId ?? null,
    bootId: stream.identity?.bootId ?? null,
    verdict: stream.verdict,
    streak: stream.streak,
    hostBacklog:
      stream.hostBacklog.status === "available"
        ? stream.hostBacklog.unacknowledgedCount
        : null,
    projectionBacklog:
      stream.projectionBacklog.status === "available"
        ? stream.projectionBacklog.maximumBacklog
        : null,
  };

  if (stream.transition === "lagging") {
    log.warn(fields, "runtime-event-stream-lagging");

    return;
  }

  log.info(
    fields,
    stream.transition === "recovered"
      ? "runtime-event-stream-lag-recovered"
      : "runtime-event-stream-lag-reset",
  );
}

function leaseLost(job: ClaimedSchedulerJob): SchedulerTickJobSummary {
  return {
    jobId: job.id,
    attemptId: job.attemptId,
    jobKind: job.jobKind,
    status: "Skipped",
    errorCode: "LEASE_LOST",
    errorMessage: "scheduler attempt lost its lease before completion",
  };
}

function succeeded(job: ClaimedSchedulerJob): SchedulerTickJobSummary {
  return {
    jobId: job.id,
    attemptId: job.attemptId,
    jobKind: job.jobKind,
    status: "Succeeded",
  };
}
