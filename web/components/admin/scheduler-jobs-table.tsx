"use client";

import type { SchedulerJobKind } from "@/lib/db/schema";
import type { ReactElement } from "react";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { SchedulerJobEditModal } from "@/components/admin/scheduler-job-edit-modal";
import { FILTERABLE_SCHEDULER_JOB_KINDS } from "@/lib/scheduler/job-catalog";
import { summarizeSchedulerTargetForDisplay } from "@/lib/scheduler/job-targets";

export interface SchedulerJobRow {
  id: string;
  projectId: string | null;
  projectName?: string | null;
  projectSlug?: string | null;
  jobKind: SchedulerJobKind;
  target: Record<string, unknown>;
  cadenceIntervalSeconds: number;
  nextRunAt: string;
  lastFiredAt: string | null;
  disabledAt: string | null;
  consecutiveFailures: number;
  maxFailures: number;
  lastStatus: string | null;
  lastFinishedAt: string | null;
  lastErrorCode: string | null;
}

export interface SchedulerJobsFilters {
  jobKind: SchedulerJobKind | "all";
  state: "all" | "active" | "disabled";
}

export interface SchedulerJobsTableProps {
  filters: SchedulerJobsFilters;
  jobs: SchedulerJobRow[];
}

const inputClass =
  "min-h-[34px] rounded-md border border-line bg-paper px-2.5 font-mono text-[11px] text-ink outline-none focus:border-amber";

const badgeBase =
  "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]";

function formatTime(iso: string | null, fallback: string): string {
  if (!iso) return fallback;

  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function SchedulerJobsTable({
  filters,
  jobs,
}: SchedulerJobsTableProps): ReactElement {
  const t = useTranslations("adminScheduler");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const [jobKind, setJobKind] = useState(filters.jobKind);
  const [state, setState] = useState(filters.state);
  const [editing, setEditing] = useState<SchedulerJobRow | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setJobKind(filters.jobKind);
    setState(filters.state);
  }, [filters.jobKind, filters.state]);

  function syncUrl(next: SchedulerJobsFilters): void {
    const params = new URLSearchParams();

    if (next.jobKind !== "all") params.set("jobKind", next.jobKind);
    if (next.state !== "all") params.set("state", next.state);

    const query = params.toString();

    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    });
  }

  return (
    <section className="rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
      <div className="flex flex-col gap-3 border-b border-line px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
              {t("tableTitle")}
            </h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              {t("tableSub")}
            </p>
          </div>
          <button
            className="shrink-0 touch-manipulation rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2"
            type="button"
            onClick={() => setCreating(true)}
          >
            {t("newJob")}
          </button>
        </div>

        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <select
            aria-label={t("filterKindAll")}
            className={inputClass}
            value={jobKind}
            onChange={(e) => {
              const next = e.target.value as SchedulerJobKind | "all";

              setJobKind(next);
              syncUrl({ jobKind: next, state });
            }}
          >
            <option value="all">{t("filterKindAll")}</option>
            {FILTERABLE_SCHEDULER_JOB_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kind.${kind}`)}
              </option>
            ))}
          </select>
          <select
            aria-label={t("filterStateAll")}
            className={inputClass}
            value={state}
            onChange={(e) => {
              const next = e.target.value as SchedulerJobsFilters["state"];

              setState(next);
              syncUrl({ jobKind, state: next });
            }}
          >
            <option value="all">{t("filterStateAll")}</option>
            <option value="active">{t("state.active")}</option>
            <option value="disabled">{t("state.disabled")}</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table
          aria-busy={pending}
          className={clsx(
            "w-full min-w-[1180px] border-collapse text-left transition-opacity",
            pending && "opacity-60",
          )}
        >
          <thead className="border-b border-line bg-ivory">
            <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
              <th className="px-5 py-3">{t("job")}</th>
              <th className="px-4 py-3">{t("projectLabel")}</th>
              <th className="px-4 py-3">{t("kindLabel")}</th>
              <th className="px-4 py-3">{t("targetLabel")}</th>
              <th className="px-4 py-3">{t("cadence")}</th>
              <th className="px-4 py-3">{t("nextRun")}</th>
              <th className="px-4 py-3">{t("stateLabel")}</th>
              <th className="px-4 py-3">{t("failures")}</th>
              <th className="px-5 py-3 text-right">{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td
                  className="px-5 py-8 text-center font-mono text-[11.5px] text-mute"
                  colSpan={9}
                >
                  {t("noResults")}
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <JobRow
                  key={job.id}
                  activeLabel={t("state.active")}
                  disabledLabel={t("state.disabled")}
                  editLabel={t("edit")}
                  globalProjectLabel={t("globalProjectLabel")}
                  invalidTargetLabel={t("invalidTarget")}
                  job={job}
                  kindLabel={t(`kind.${job.jobKind}`)}
                  neverLabel={t("never")}
                  secondsSuffix={t("secondsSuffix")}
                  onEdit={() => setEditing(job)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {creating ? (
        <SchedulerJobEditModal
          job={null}
          onClose={() => setCreating(false)}
          onSaved={() => startTransition(() => router.refresh())}
        />
      ) : null}
      {editing ? (
        <SchedulerJobEditModal
          job={editing}
          onClose={() => setEditing(null)}
          onSaved={() => startTransition(() => router.refresh())}
        />
      ) : null}
    </section>
  );
}

function JobRow({
  job,
  kindLabel,
  activeLabel,
  disabledLabel,
  neverLabel,
  secondsSuffix,
  editLabel,
  globalProjectLabel,
  invalidTargetLabel,
  onEdit,
}: {
  activeLabel: string;
  disabledLabel: string;
  editLabel: string;
  globalProjectLabel: string;
  invalidTargetLabel: string;
  job: SchedulerJobRow;
  kindLabel: string;
  neverLabel: string;
  onEdit: () => void;
  secondsSuffix: string;
}): ReactElement {
  const isDisabled = job.disabledAt !== null;
  const targetSummary = summarizeSchedulerTargetForDisplay({
    jobKind: job.jobKind,
    target: job.target,
  });

  return (
    <tr className="border-b border-line align-middle last:border-b-0">
      <td className="px-5 py-3.5">
        <div className="max-w-[280px] truncate font-mono text-[11.5px] font-semibold text-ink">
          {job.id}
        </div>
        {job.lastErrorCode ? (
          <div className="max-w-[280px] truncate font-mono text-[10px] tracking-[0.03em] text-mute">
            {job.lastErrorCode}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3.5">
        {job.projectSlug ? (
          <Link
            className="block max-w-[180px] truncate text-[12px] font-semibold text-ink-2 underline-offset-2 hover:underline"
            href={`/projects/${job.projectSlug}`}
          >
            {job.projectName ?? job.projectSlug}
          </Link>
        ) : (
          <span className="font-mono text-[11px] text-mute">
            {globalProjectLabel}
          </span>
        )}
      </td>
      <td className="px-4 py-3.5">
        <span className={clsx(badgeBase, "border-line bg-ivory text-ink-2")}>
          {kindLabel}
        </span>
      </td>
      <td className="px-4 py-3.5">
        <div
          className={clsx(
            "max-w-[260px] truncate text-[12px]",
            targetSummary.ok ? "text-ink-2" : "font-mono text-danger",
          )}
          title={
            targetSummary.ok
              ? targetSummary.summary
              : targetSummary.errorMessage
          }
        >
          {targetSummary.ok ? targetSummary.summary : invalidTargetLabel}
        </div>
      </td>
      <td className="px-4 py-3.5 font-mono text-[11px] tabular-nums text-ink-2">
        {job.cadenceIntervalSeconds}
        {secondsSuffix}
      </td>
      <td
        suppressHydrationWarning
        className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute"
      >
        {formatTime(job.nextRunAt, neverLabel)}
      </td>
      <td className="px-4 py-3.5">
        <span
          className={clsx(
            badgeBase,
            isDisabled
              ? "border-line bg-ivory text-mute"
              : "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
          )}
        >
          {isDisabled ? disabledLabel : activeLabel}
        </span>
      </td>
      <td className="px-4 py-3.5 font-mono text-[11px] tabular-nums text-ink-2">
        {job.consecutiveFailures}/{job.maxFailures}
      </td>
      <td className="px-5 py-3.5 text-right">
        <button
          aria-label={`${editLabel} · ${job.id}`}
          className="touch-manipulation rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10.5px] font-semibold tracking-[0.03em] text-ink-2 transition-colors hover:border-mute hover:text-ink"
          type="button"
          onClick={onEdit}
        >
          {editLabel}
        </button>
      </td>
    </tr>
  );
}
