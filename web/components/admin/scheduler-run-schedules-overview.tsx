"use client";

import type { SchedulerRunScheduleOverviewViewRow } from "@/types/scheduler";
import type { ReactElement } from "react";

import Link from "next/link";
import { useTranslations } from "next-intl";
import clsx from "clsx";

export type SchedulerRunScheduleOverviewRow =
  SchedulerRunScheduleOverviewViewRow;

export interface SchedulerRunSchedulesOverviewProps {
  schedules: SchedulerRunScheduleOverviewRow[];
}

const badgeBase =
  "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]";

const OUTCOME_TONE: Record<
  NonNullable<SchedulerRunScheduleOverviewRow["lastFireOutcome"]>,
  string
> = {
  catchup_queued: "border-amber-line bg-amber-soft text-amber",
  dispatching: "animate-pulse border-amber-line bg-amber-soft text-amber",
  launch_failed:
    "border-[color-mix(in_oklab,var(--danger)_35%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger",
  launched:
    "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
  queued_pending: "border-amber-line bg-amber-soft text-amber",
  skipped_blocked: "border-line bg-ivory text-mute",
  skipped_cap: "border-line bg-ivory text-mute",
  skipped_crashed: "border-line bg-ivory text-mute",
  skipped_flagged: "border-line bg-ivory text-mute",
  skipped_task_busy: "border-line bg-ivory text-mute",
  skipped_target_terminal: "border-line bg-ivory text-mute",
  skipped_unconfigured: "border-line bg-ivory text-mute",
};

function formatInTimezone(iso: string | null, timeZone: string): string {
  if (!iso) return "—";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}

export function SchedulerRunSchedulesOverview({
  schedules,
}: SchedulerRunSchedulesOverviewProps): ReactElement {
  const t = useTranslations("adminScheduler");

  return (
    <section className="rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
      <div className="border-b border-line px-5 py-4">
        <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
          {t("schedules.tableTitle")}
        </h2>
        <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
          {t("schedules.tableSub")}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse text-left">
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
              <th className="px-5 py-3">{t("schedules.schedule")}</th>
              <th className="px-4 py-3">{t("projectLabel")}</th>
              <th className="px-4 py-3">{t("schedules.task")}</th>
              <th className="px-4 py-3">{t("schedules.cron")}</th>
              <th className="px-4 py-3">{t("stateLabel")}</th>
              <th className="px-4 py-3">{t("schedules.nextFire")}</th>
              <th className="px-4 py-3">{t("schedules.lastOutcome")}</th>
              <th className="px-5 py-3 text-right">{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 ? (
              <tr>
                <td
                  className="px-5 py-8 text-center font-mono text-[11.5px] text-mute"
                  colSpan={8}
                >
                  {t("schedules.noResults")}
                </td>
              </tr>
            ) : (
              schedules.map((schedule) => (
                <ScheduleRow key={schedule.scheduleId} schedule={schedule} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ScheduleRow({
  schedule,
}: {
  schedule: SchedulerRunScheduleOverviewRow;
}): ReactElement {
  const t = useTranslations("adminScheduler");
  const schedulesHref = `/projects/${schedule.projectSlug}?tab=schedules`;
  const lastRunHref = schedule.lastRunId
    ? `/runs/${encodeURIComponent(schedule.lastRunId)}`
    : null;

  return (
    <tr className="border-b border-line align-middle last:border-b-0">
      <td className="px-5 py-3.5">
        <div className="max-w-[220px] truncate font-semibold text-[12.5px] text-ink">
          {schedule.scheduleName}
        </div>
        <div className="mt-1 font-mono text-[10px] text-mute">
          {schedule.scheduleId}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <Link
          className="block max-w-[180px] truncate text-[12px] font-semibold text-ink-2 underline-offset-2 hover:underline"
          href={schedulesHref}
        >
          {schedule.projectName}
        </Link>
      </td>
      <td className="px-4 py-3.5">
        <div className="max-w-[240px] truncate text-[12px] text-ink-2">
          #{schedule.taskNumber} {schedule.taskTitle}
        </div>
        <div className="mt-1 font-mono text-[10px] text-mute">
          {schedule.taskStatus}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <div className="font-mono text-[11.5px] text-ink">
          {schedule.cronExpr}
        </div>
        <div className="mt-1 font-mono text-[10px] text-mute">
          {schedule.timezone} ·{" "}
          {t(`schedules.overlap.${schedule.overlapPolicy}`)}
        </div>
        {schedule.runnerId ? (
          <div className="mt-1 max-w-[220px] truncate font-mono text-[10px] text-mute">
            {schedule.runnerId}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3.5">
        <span
          className={clsx(
            badgeBase,
            schedule.enabled
              ? "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good"
              : "border-line bg-ivory text-mute",
          )}
        >
          {schedule.enabled ? t("state.active") : t("state.disabled")}
        </span>
      </td>
      <td
        suppressHydrationWarning
        className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute"
      >
        {formatInTimezone(schedule.nextFireAt, schedule.timezone)}
        {schedule.queueOnePending ? (
          <div className="mt-1.5">
            <span
              className={clsx(
                badgeBase,
                "border-amber-line bg-amber-soft text-amber",
              )}
            >
              {t("schedules.queuedCatchUp")}
            </span>
            {schedule.queuedFireAt ? (
              <div className="mt-1 text-[10px] tabular-nums text-mute">
                {formatInTimezone(schedule.queuedFireAt, schedule.timezone)}
              </div>
            ) : null}
          </div>
        ) : null}
      </td>
      <td suppressHydrationWarning className="px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {schedule.lastFireOutcome ? (
            <span
              className={clsx(
                badgeBase,
                OUTCOME_TONE[schedule.lastFireOutcome],
              )}
            >
              {t(`schedules.outcome.${schedule.lastFireOutcome}`)}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-mute">—</span>
          )}
          {lastRunHref ? (
            <Link
              aria-label={`${t("schedules.openLastRun")} · ${schedule.scheduleName}`}
              className={clsx(
                badgeBase,
                "border-line bg-paper text-ink-2 underline-offset-2 hover:border-mute hover:text-ink hover:underline",
              )}
              href={lastRunHref}
            >
              {schedule.lastRunStatus ?? t("schedules.openLastRun")}
            </Link>
          ) : schedule.lastRunStatus ? (
            <span
              className={clsx(badgeBase, "border-line bg-paper text-ink-2")}
            >
              {schedule.lastRunStatus}
            </span>
          ) : null}
        </div>
        {schedule.lastFireError ? (
          <div
            className="mt-1 max-w-[260px] truncate font-mono text-[10px] tracking-[0.02em] text-danger"
            title={schedule.lastFireError}
          >
            {schedule.lastFireError}
          </div>
        ) : null}
        {schedule.lastFiredAt ? (
          <div className="mt-1 font-mono text-[10px] tabular-nums text-mute">
            {formatInTimezone(schedule.lastFiredAt, schedule.timezone)}
          </div>
        ) : null}
      </td>
      <td className="px-5 py-3.5 text-right">
        <Link
          aria-label={`${t("schedules.openProjectSchedules")} · ${schedule.scheduleName}`}
          className="touch-manipulation rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.03em] text-ink-2 transition-colors hover:border-mute hover:text-ink"
          href={schedulesHref}
        >
          {t("schedules.openProjectSchedules")}
        </Link>
      </td>
    </tr>
  );
}
