import type { SchedulerJobKind } from "@/lib/db/schema";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import {
  SchedulerJobsTable,
  type SchedulerJobRow,
} from "@/components/admin/scheduler-jobs-table";
import {
  SchedulerRunSchedulesOverview,
  type SchedulerRunScheduleOverviewRow,
} from "@/components/admin/scheduler-run-schedules-overview";
import { requireGlobalRole } from "@/lib/authz";
import {
  listSchedulerRunScheduleOverviewRows,
  listSchedulerStatusRows,
} from "@/lib/queries/scheduler";
import { FILTERABLE_SCHEDULER_JOB_KINDS } from "@/lib/scheduler/job-catalog";

const STATES = ["active", "disabled"] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adminScheduler");

  return { title: t("title") };
}

export default async function AdminSchedulerPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactElement> {
  await requireGlobalRole("admin");

  const t = await getTranslations("adminScheduler");
  const sp = await searchParams;

  const kindParam = first(sp.jobKind);
  const stateParam = first(sp.state);
  const jobKind =
    kindParam &&
    (FILTERABLE_SCHEDULER_JOB_KINDS as readonly string[]).includes(kindParam)
      ? (kindParam as SchedulerJobKind)
      : undefined;
  const state =
    stateParam && (STATES as readonly string[]).includes(stateParam)
      ? (stateParam as (typeof STATES)[number])
      : undefined;

  const [all, schedules] = await Promise.all([
    listSchedulerStatusRows({ limit: 200 }),
    listSchedulerRunScheduleOverviewRows({ limit: 200 }),
  ]);
  const filtered = all.filter((job) => {
    if (jobKind && job.jobKind !== jobKind) return false;
    if (state === "active" && job.disabledAt !== null) return false;
    if (state === "disabled" && job.disabledAt === null) return false;

    return true;
  });

  const rows: SchedulerJobRow[] = filtered.map((job) => ({
    id: job.id,
    projectId: job.projectId,
    projectName: job.projectName,
    projectSlug: job.projectSlug,
    jobKind: job.jobKind,
    target: job.target,
    cadenceIntervalSeconds: job.cadenceIntervalSeconds,
    nextRunAt: job.nextRunAt.toISOString(),
    lastFiredAt: job.lastFiredAt?.toISOString() ?? null,
    disabledAt: job.disabledAt?.toISOString() ?? null,
    consecutiveFailures: job.consecutiveFailures,
    maxFailures: job.maxFailures,
    lastStatus: job.lastStatus,
    lastFinishedAt: job.lastFinishedAt?.toISOString() ?? null,
    lastErrorCode: job.lastErrorCode,
  }));
  const scheduleRows: SchedulerRunScheduleOverviewRow[] = schedules.map(
    (schedule) => ({
      scheduleId: schedule.scheduleId,
      scheduleName: schedule.scheduleName,
      projectId: schedule.projectId,
      projectSlug: schedule.projectSlug,
      projectName: schedule.projectName,
      taskId: schedule.taskId,
      taskNumber: schedule.taskNumber,
      taskTitle: schedule.taskTitle,
      taskStatus: schedule.taskStatus,
      cronExpr: schedule.cronExpr,
      timezone: schedule.timezone,
      overlapPolicy: schedule.overlapPolicy,
      runnerId: schedule.runnerId,
      enabled: schedule.enabled,
      nextFireAt: schedule.nextFireAt.toISOString(),
      queueOnePending: schedule.queueOnePending,
      queuedFireAt: schedule.queuedFireAt?.toISOString() ?? null,
      lastFiredAt: schedule.lastFiredAt?.toISOString() ?? null,
      lastFireOutcome: schedule.lastFireOutcome,
      lastFireError: schedule.lastFireError,
      lastRunId: schedule.lastRunId,
      lastRunStatus: schedule.lastRunStatus,
    }),
  );

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
          {t("eyebrow")}
        </div>
        <div>
          <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-[680px] text-[13.5px] leading-[1.55] text-mute">
            {t("sub")}
          </p>
        </div>
      </header>

      <SchedulerJobsTable
        filters={{
          jobKind: jobKind ?? "all",
          state: state ?? "all",
        }}
        jobs={rows}
      />
      <SchedulerRunSchedulesOverview schedules={scheduleRows} />
    </div>
  );
}
