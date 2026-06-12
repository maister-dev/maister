import "server-only";

import pino from "pino";

import {
  claimDueJobs,
  ensureDefaultSchedulerJobs,
  reapStuckSchedulerAttempts,
  recordJobAttemptResult,
  recordJobAttemptStarted,
  type ClaimedSchedulerJob,
  type SchedulerJobKind,
} from "@/lib/scheduler/jobs";
import { dispatchDueSchedules } from "@/lib/run-schedules/dispatch";
import { runAgentTickJob } from "@/lib/scheduler/handlers/agent-tick";
import { runCommandJob } from "@/lib/scheduler/handlers/command";
import { runDomainEventDispatchJob } from "@/lib/scheduler/handlers/domain-event-dispatch";
import { runScheduledFlowJob } from "@/lib/scheduler/handlers/flow-run";
import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";
import { runSystemSweep } from "@/lib/scheduler/system-sweeps";
import { isMaisterError } from "@/lib/errors";

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
};

const log = pino({
  name: "scheduler-tick",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function runSchedulerTick(
  input: RunSchedulerTickInput = {},
): Promise<SchedulerTickSummary> {
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

  return summary;
}

async function runClaimedJob(
  job: ClaimedSchedulerJob,
): Promise<SchedulerTickJobSummary> {
  await recordJobAttemptStarted({ attemptId: job.attemptId });

  try {
    switch (job.jobKind) {
      case "system_sweep":
        await runSystemSweep();
        await recordJobAttemptResult({
          jobId: job.id,
          attemptId: job.attemptId,
          status: "Succeeded",
        });

        return succeeded(job);
      case "command":
        await runCommandJob(job.target);
        await recordJobAttemptResult({
          jobId: job.id,
          attemptId: job.attemptId,
          status: "Succeeded",
        });

        return succeeded(job);
      case "agent_tick": {
        // M33 (ADR-087): the stub finally gets its launcher — the
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

        await recordJobAttemptResult({
          jobId: job.id,
          attemptId: job.attemptId,
          status: "Succeeded",
          summary: agentTickSummary,
        });

        return succeeded(job);
      }
      case "flow_run":
        await runScheduledFlowJob(job.target);
        await recordJobAttemptResult({
          jobId: job.id,
          attemptId: job.attemptId,
          status: "Succeeded",
        });

        return succeeded(job);
      case "run_schedule": {
        const dispatchSummary = await dispatchDueSchedules();

        await recordJobAttemptResult({
          jobId: job.id,
          attemptId: job.attemptId,
          status: "Succeeded",
          summary: dispatchSummary,
        });

        return succeeded(job);
      }
      case "webhook_delivery":
        await recordJobAttemptResult({
          jobId: job.id,
          attemptId: job.attemptId,
          status: "Succeeded",
          summary: await runWebhookDeliveryJob(),
        });

        return succeeded(job);
      case "domain_event_dispatch":
        await recordJobAttemptResult({
          jobId: job.id,
          attemptId: job.attemptId,
          status: "Succeeded",
          summary: await runDomainEventDispatchJob(),
        });

        return succeeded(job);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isSkip = isMaisterError(err) && err.code === "PRECONDITION";
    const status = isSkip ? "Skipped" : "Failed";
    const errorCode = isMaisterError(err) ? err.code : "SCHEDULER_HANDLER";

    await recordJobAttemptResult({
      jobId: job.id,
      attemptId: job.attemptId,
      status,
      errorCode,
      errorMessage: message,
    });

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

function succeeded(job: ClaimedSchedulerJob): SchedulerTickJobSummary {
  return {
    jobId: job.id,
    attemptId: job.attemptId,
    jobKind: job.jobKind,
    status: "Succeeded",
  };
}
