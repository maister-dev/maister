"use client";

import type {
  BrainIndexJobStatus,
  BrainIndexQueueViewData,
  BrainIndexQueueViewRow,
  SchedulerClockDriver,
  SchedulerClockStatus,
} from "@/types/scheduler";
import type { ReactElement } from "react";

import Link from "next/link";
import { useTranslations } from "next-intl";
import clsx from "clsx";

export interface SchedulerBrainIndexQueueProps {
  clock: SchedulerClockStatus;
  queue: BrainIndexQueueViewData;
}

const badgeBase =
  "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase";

const DRIVER_TONE: Record<SchedulerClockDriver, string> = {
  external_tick: "border-amber-line bg-amber-soft text-amber",
  fallback_timer:
    "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
  missing_tick:
    "border-[color-mix(in_oklab,var(--danger)_35%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger",
};

const STATUS_TONE: Record<BrainIndexJobStatus, string> = {
  completed:
    "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
  failed:
    "border-[color-mix(in_oklab,var(--danger)_35%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger",
  queued: "border-amber-line bg-amber-soft text-amber",
  running: "animate-pulse border-amber-line bg-amber-soft text-amber",
};

function formatTime(iso: string | null, fallback: string): string {
  if (!iso) return fallback;

  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : null;
}

function summarizeRecord(
  record: Record<string, unknown> | null,
): string | null {
  if (!record) return null;

  const code = stringField(record, "code");
  const message =
    stringField(record, "message") ?? stringField(record, "error");

  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  if (code) return code;

  try {
    return JSON.stringify(record);
  } catch {
    return null;
  }
}

function jobError(job: BrainIndexQueueViewRow): string | null {
  return (
    summarizeRecord(job.sourceLastError) ?? summarizeRecord(job.resumableCursor)
  );
}

export function SchedulerBrainIndexQueue({
  clock,
  queue,
}: SchedulerBrainIndexQueueProps): ReactElement {
  const t = useTranslations("adminScheduler");
  const clockGuidance = t(`brainQueue.clock.guidance.${clock.driver}`, {
    path: clock.tickPath,
    seconds: clock.tickIntervalSeconds,
  });

  return (
    <section className="rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
      <div className="border-b border-line px-5 py-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="m-0 text-[17px] font-semibold text-ink">
              {t("brainQueue.tableTitle")}
            </h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              {t("brainQueue.tableSub")}
            </p>
          </div>
          <span className={clsx(badgeBase, DRIVER_TONE[clock.driver])}>
            {t(`brainQueue.clock.driver.${clock.driver}`)}
          </span>
        </div>

        <dl className="mt-4 grid gap-x-5 gap-y-3 border-t border-line pt-4 md:grid-cols-4">
          <div>
            <dt className="font-mono text-[10px] uppercase text-mute">
              {t("brainQueue.clock.tickPath")}
            </dt>
            <dd className="mt-1 font-mono text-[11.5px] text-ink">
              {clock.tickPath}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase text-mute">
              {t("brainQueue.clock.interval")}
            </dt>
            <dd className="mt-1 font-mono text-[11.5px] text-ink">
              {clock.tickIntervalSeconds}
              {t("secondsSuffix")}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase text-mute">
              {t("brainQueue.clock.cronToken")}
            </dt>
            <dd className="mt-1 font-mono text-[11.5px] text-ink">
              {clock.cronTokenConfigured
                ? t("brainQueue.clock.configured")
                : t("brainQueue.clock.missing")}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[10px] uppercase text-mute">
              {t("brainQueue.clock.guidanceLabel")}
            </dt>
            <dd className="mt-1 text-[12px] leading-[1.45] text-ink-2">
              {clockGuidance}
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          <QueueCount
            label={t("brainQueue.status.queued")}
            value={queue.summary.queued}
          />
          <QueueCount
            label={t("brainQueue.status.running")}
            value={queue.summary.running}
          />
          <QueueCount
            label={t("brainQueue.status.failed")}
            value={queue.summary.failed}
          />
          <QueueCount
            label={t("brainQueue.status.completed")}
            value={queue.summary.completed}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse text-left">
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase text-mute">
              <th className="px-5 py-3">{t("projectLabel")}</th>
              <th className="px-4 py-3">{t("brainQueue.source")}</th>
              <th className="px-4 py-3">{t("brainQueue.reason")}</th>
              <th className="px-4 py-3">{t("stateLabel")}</th>
              <th className="px-4 py-3">{t("brainQueue.progress")}</th>
              <th className="px-4 py-3">{t("brainQueue.created")}</th>
              <th className="px-4 py-3">{t("brainQueue.lastIndexed")}</th>
              <th className="px-5 py-3">{t("brainQueue.error")}</th>
            </tr>
          </thead>
          <tbody>
            {!queue.schemaApplied ? (
              <tr>
                <td
                  className="px-5 py-8 text-center font-mono text-[11.5px] text-mute"
                  colSpan={8}
                >
                  {t("brainQueue.schemaMissing")}
                </td>
              </tr>
            ) : queue.rows.length === 0 ? (
              <tr>
                <td
                  className="px-5 py-8 text-center font-mono text-[11.5px] text-mute"
                  colSpan={8}
                >
                  {t("brainQueue.noResults")}
                </td>
              </tr>
            ) : (
              queue.rows.map((job) => (
                <BrainIndexJobRow key={job.id} job={job} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function QueueCount({
  label,
  value,
}: {
  label: string;
  value: number;
}): ReactElement {
  return (
    <span className={clsx(badgeBase, "border-line bg-ivory text-ink-2")}>
      {label}: {value}
    </span>
  );
}

function BrainIndexJobRow({
  job,
}: {
  job: BrainIndexQueueViewRow;
}): ReactElement {
  const t = useTranslations("adminScheduler");
  const errorText = jobError(job);

  return (
    <tr className="border-b border-line align-middle last:border-b-0">
      <td className="px-5 py-3.5">
        <Link
          className="block max-w-[180px] truncate text-[12px] font-semibold text-ink-2 underline-offset-2 hover:underline"
          href={`/projects/${job.projectSlug}?tab=brain`}
        >
          {job.projectName}
        </Link>
        <div className="mt-1 font-mono text-[10px] text-mute">
          {job.projectSlug}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <div
          className="max-w-[300px] truncate font-mono text-[11.5px] text-ink"
          title={job.sourcePath ?? job.id}
        >
          {job.sourcePath ?? t("brainQueue.ownedGeneration")}
        </div>
        <div className="mt-1 max-w-[300px] truncate font-mono text-[10px] text-mute">
          {job.id}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <span className={clsx(badgeBase, "border-line bg-ivory text-ink-2")}>
          {t(`brainQueue.reasonValue.${job.reason}`)}
        </span>
      </td>
      <td className="px-4 py-3.5">
        <span className={clsx(badgeBase, STATUS_TONE[job.status])}>
          {t(`brainQueue.status.${job.status}`)}
        </span>
      </td>
      <td className="px-4 py-3.5 font-mono text-[11.5px] tabular-nums text-ink">
        {job.progress}
      </td>
      <td
        suppressHydrationWarning
        className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute"
      >
        {formatTime(job.createdAt, t("never"))}
      </td>
      <td
        suppressHydrationWarning
        className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute"
      >
        {formatTime(job.sourceLastIndexedAt, t("never"))}
      </td>
      <td className="px-5 py-3.5">
        {errorText ? (
          <div
            className="max-w-[280px] truncate font-mono text-[10px] text-danger"
            title={errorText}
          >
            {errorText}
          </div>
        ) : (
          <span className="font-mono text-[11px] text-mute">—</span>
        )}
      </td>
    </tr>
  );
}
