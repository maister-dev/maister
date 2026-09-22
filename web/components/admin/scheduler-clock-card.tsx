"use client";

import type {
  SchedulerClockDriver,
  SchedulerClockStatus,
  SchedulerCoreJobClockRow,
} from "@/types/scheduler";
import type { ReactElement } from "react";

import { useTranslations } from "next-intl";
import clsx from "clsx";

const DRIVER_TONE: Record<SchedulerClockDriver, string> = {
  external_tick: "border-amber-line bg-amber-soft text-amber",
  fallback_timer:
    "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
  missing_tick:
    "border-[color-mix(in_oklab,var(--danger)_35%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger",
};

function time(value: string | null, never: string): string {
  return value ? new Date(value).toLocaleString() : never;
}

export function SchedulerClockCard({
  clock,
  coreJobs,
}: {
  clock: SchedulerClockStatus;
  coreJobs: SchedulerCoreJobClockRow[];
}): ReactElement {
  const t = useTranslations("adminScheduler.clockCard");
  const jobsById = new Map(coreJobs.map((job) => [job.id, job]));
  const coreIds = [
    "system_sweep.default",
    "domain_event_dispatch.default",
  ] as const;

  return (
    <section className="rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
      <div className="flex flex-col gap-3 border-b border-line px-5 py-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="m-0 text-[17px] font-semibold text-ink">
            {t("title")}
          </h2>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
            {t("subtitle")}
          </p>
        </div>
        <span
          className={clsx(
            "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase",
            DRIVER_TONE[clock.driver],
          )}
        >
          {t(`driver.${clock.driver}`)}
        </span>
      </div>

      <dl className="grid gap-4 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("interval")}
          </dt>
          <dd className="mt-1 text-sm text-ink">
            {clock.tickIntervalSeconds}s
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("cronToken")}
          </dt>
          <dd className="mt-1 text-sm text-ink">
            {clock.cronTokenConfigured ? t("configured") : t("missing")}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("lastStarted")}
          </dt>
          <dd className="mt-1 text-sm text-ink">
            {time(clock.health.lastStartedAt, t("never"))}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("lastFinished")}
          </dt>
          <dd className="mt-1 text-sm text-ink">
            {time(clock.health.lastFinishedAt, t("never"))}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("duration")}
          </dt>
          <dd className="mt-1 text-sm text-ink">
            {clock.health.lastDurationMs === null
              ? t("never")
              : `${Math.round(clock.health.lastDurationMs)}ms`}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("outcome")}
          </dt>
          <dd className="mt-1 text-sm text-ink">
            {clock.health.lastOutcome
              ? t(`outcomes.${clock.health.lastOutcome}`)
              : t("never")}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("active")}
          </dt>
          <dd className="mt-1 text-sm text-ink">{clock.health.activeCount}</dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("overlap")}
          </dt>
          <dd className="mt-1 text-sm text-ink">
            {t("overlapValue", {
              total: clock.health.skippedOverlapTotal,
              current: clock.health.skippedOverlapCurrentStreak,
              last: clock.health.skippedOverlapLastStreak,
            })}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase text-mute">
            {t("process")}
          </dt>
          <dd className="mt-1 font-mono text-xs text-ink">
            {clock.health.processId}
          </dd>
        </div>
      </dl>

      <p className="px-5 pb-4 text-xs text-mute">
        {t(`guidance.${clock.driver}`, {
          path: clock.tickPath,
          seconds: clock.tickIntervalSeconds,
        })}
      </p>

      <div className="overflow-x-auto border-t border-line">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="text-mute">
              <th className="px-5 py-3">{t("job")}</th>
              <th className="px-3 py-3">{t("status")}</th>
              <th className="px-3 py-3">{t("lastRun")}</th>
              <th className="px-3 py-3">{t("duration")}</th>
              <th className="px-3 py-3">{t("errorCode")}</th>
              <th className="px-5 py-3">{t("nextRun")}</th>
            </tr>
          </thead>
          <tbody>
            {coreIds.map((id) => {
              const job = jobsById.get(id);
              const durationMs =
                job?.lastStartedAt && job.lastFinishedAt
                  ? new Date(job.lastFinishedAt).getTime() -
                    new Date(job.lastStartedAt).getTime()
                  : null;

              return (
                <tr key={id} className="border-t border-line">
                  <td className="px-5 py-3 font-mono text-xs">{id}</td>
                  <td className="px-3 py-3">
                    {job?.disabledAt
                      ? t("disabled")
                      : (job?.lastStatus ?? t("missingJob"))}
                  </td>
                  <td className="px-3 py-3">
                    {time(job?.lastFinishedAt ?? null, t("never"))}
                  </td>
                  <td className="px-3 py-3">
                    {durationMs === null ? t("never") : `${durationMs}ms`}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {job?.lastErrorCode ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    {time(job?.nextRunAt ?? null, t("never"))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
