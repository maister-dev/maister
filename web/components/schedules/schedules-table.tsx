"use client";

import type { RunScheduleFireOutcome } from "@/lib/db/schema";
import type { ScheduleDTO } from "@/lib/run-schedules/queries";
import type { ReactElement } from "react";

import { useTranslations } from "next-intl";
import clsx from "clsx";

const badgeBase =
  "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]";

const actionButton =
  "touch-manipulation rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.03em] text-ink-2 transition-colors hover:border-mute hover:text-ink";

const OUTCOME_TONE: Record<RunScheduleFireOutcome, string> = {
  launched:
    "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
  queued_pending: "border-amber-line bg-amber-soft text-amber",
  catchup_queued: "border-amber-line bg-amber-soft text-amber",
  skipped_task_busy: "border-line bg-ivory text-mute",
  skipped_cap: "border-line bg-ivory text-mute",
  skipped_target_terminal: "border-line bg-ivory text-mute",
  skipped_crashed: "border-line bg-ivory text-mute",
  skipped_blocked: "border-line bg-ivory text-mute",
  launch_failed:
    "border-[color-mix(in_oklab,var(--danger)_35%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger",
  dispatching: "animate-pulse border-amber-line bg-amber-soft text-amber",
};

function formatInTimezone(iso: string | null, timeZone: string): string {
  if (!iso) return "—";

  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

export interface SchedulesTableProps {
  busy: boolean;
  canManage: boolean;
  schedules: ScheduleDTO[];
  onEdit: (schedule: ScheduleDTO) => void;
  onToggleEnabled: (schedule: ScheduleDTO) => void;
  onTrigger: (schedule: ScheduleDTO) => void;
}

export function SchedulesTable({
  busy,
  canManage,
  schedules,
  onEdit,
  onToggleEnabled,
  onTrigger,
}: SchedulesTableProps): ReactElement {
  const t = useTranslations("projectSchedules");

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-paper">
      <table
        aria-busy={busy}
        className={clsx(
          "w-full min-w-[1080px] border-collapse text-left transition-opacity",
          busy && "opacity-60",
        )}
      >
        <thead className="border-b border-line bg-ivory">
          <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
            <th className="px-5 py-3">{t("table.name")}</th>
            <th className="px-4 py-3">{t("table.task")}</th>
            <th className="px-4 py-3">{t("table.cron")}</th>
            <th className="px-4 py-3">{t("table.timezone")}</th>
            <th className="px-4 py-3">{t("table.overlap")}</th>
            <th className="px-4 py-3">{t("table.state")}</th>
            <th className="px-4 py-3">{t("table.nextFire")}</th>
            <th className="px-4 py-3">{t("table.lastOutcome")}</th>
            {canManage ? <th className="px-5 py-3 text-right" /> : null}
          </tr>
        </thead>
        <tbody>
          {schedules.length === 0 ? (
            <tr>
              <td
                className="px-5 py-8 text-center font-mono text-[11.5px] text-mute"
                colSpan={canManage ? 9 : 8}
              >
                {t("empty")}
              </td>
            </tr>
          ) : (
            schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.id}
                canManage={canManage}
                schedule={schedule}
                onEdit={() => onEdit(schedule)}
                onToggleEnabled={() => onToggleEnabled(schedule)}
                onTrigger={() => onTrigger(schedule)}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleRow({
  canManage,
  schedule,
  onEdit,
  onToggleEnabled,
  onTrigger,
}: {
  canManage: boolean;
  schedule: ScheduleDTO;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onTrigger: () => void;
}): ReactElement {
  const t = useTranslations("projectSchedules");

  return (
    <tr className="border-b border-line align-middle last:border-b-0">
      <td className="px-5 py-3.5">
        <div className="max-w-[220px] truncate font-semibold text-[12.5px] text-ink">
          {schedule.name}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <div className="max-w-[220px] truncate text-[12px] text-ink-2">
          {schedule.taskTitle ?? "—"}
        </div>
      </td>
      <td className="px-4 py-3.5 font-mono text-[11.5px] text-ink">
        {schedule.cronExpr}
      </td>
      <td className="px-4 py-3.5 font-mono text-[10.5px] text-ink-2">
        {schedule.timezone}
      </td>
      <td className="px-4 py-3.5">
        <span className={clsx(badgeBase, "border-line bg-ivory text-ink-2")}>
          {t(`overlap.${schedule.overlapPolicy}`)}
        </span>
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
          {schedule.enabled ? t("enabledBadge") : t("pausedBadge")}
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
              {t("queuedCatchUp")}
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
              {t(`outcome.${schedule.lastFireOutcome}`)}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-mute">—</span>
          )}
          {schedule.lastRunStatus ? (
            <span
              className={clsx(badgeBase, "border-line bg-paper text-ink-2")}
            >
              {schedule.lastRunStatus}
            </span>
          ) : null}
        </div>
        {schedule.lastFireError ? (
          <div
            className="mt-1 max-w-[240px] truncate font-mono text-[10px] tracking-[0.02em] text-danger"
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
      {canManage ? (
        <td className="px-5 py-3.5 text-right">
          <div className="flex items-center justify-end gap-2">
            <button
              aria-label={`${schedule.enabled ? t("pause") : t("resume")} · ${schedule.name}`}
              className={actionButton}
              type="button"
              onClick={onToggleEnabled}
            >
              {schedule.enabled ? t("pause") : t("resume")}
            </button>
            <button
              aria-label={`${t("triggerNow")} · ${schedule.name}`}
              className={actionButton}
              type="button"
              onClick={onTrigger}
            >
              {t("triggerNow")}
            </button>
            <button
              aria-label={`${t("edit")} · ${schedule.name}`}
              className={actionButton}
              type="button"
              onClick={onEdit}
            >
              {t("edit")}
            </button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}
