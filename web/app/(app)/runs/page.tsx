import type { RunsListFilters, RunsListRow } from "@/lib/queries/runs-list";
import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FunnelIcon,
} from "@heroicons/react/24/outline";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { requireActiveSession } from "@/lib/authz";
import {
  listRunsPage,
  normalizeRunsListFilters,
  RUNS_LIST_SOURCES,
  RUNS_LIST_STATUSES,
} from "@/lib/queries/runs-list";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PAGE_SIZE = 50;

const STATUS_TONE: Record<RunsListRow["status"], string> = {
  Abandoned: "border-line bg-ivory text-mute",
  Crashed:
    "border-[color-mix(in_oklab,var(--danger)_35%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger",
  Done: "border-[color-mix(in_oklab,var(--good)_35%,var(--line))] bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
  Failed:
    "border-[color-mix(in_oklab,var(--danger)_35%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger",
  HumanWorking: "border-line bg-paper text-ink-2",
  NeedsInput: "border-amber-line bg-amber-soft text-amber",
  NeedsInputIdle: "border-amber-line bg-amber-soft text-amber",
  Pending: "border-line bg-ivory text-mute",
  Review:
    "border-[color-mix(in_oklab,var(--accent-2)_35%,var(--line))] bg-[color-mix(in_oklab,var(--accent-2)_10%,transparent)] text-accent-2",
  Running:
    "border-[color-mix(in_oklab,var(--accent-4)_35%,var(--line))] bg-[color-mix(in_oklab,var(--accent-4)_12%,transparent)] text-accent-4",
};

function filtersToParams(filters: RunsListFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.projectSlug) params.set("project", filters.projectSlug);
  if (filters.status) params.set("status", filters.status);
  if (filters.source) params.set("source", filters.source);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.dateFrom) params.set("from", filters.dateFrom);
  if (filters.dateTo) params.set("to", filters.dateTo);
  if (filters.page > 1) params.set("page", String(filters.page));

  return params;
}

function pageHref(filters: RunsListFilters, page: number): string {
  const params = filtersToParams({ ...filters, page });
  const query = params.toString();

  return query ? `/runs?${query}` : "/runs";
}

function formatDateTime(locale: string, value: Date): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) return `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return `${hours}h ${remainingMinutes}m`;
}

function compactId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("runsList");

  return { title: t("title") };
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const [params, t, locale] = await Promise.all([
    searchParams,
    getTranslations("runsList"),
    getLocale(),
  ]);
  const filters = normalizeRunsListFilters(params);
  const page = await listRunsPage({
    filters,
    pageSize: PAGE_SIZE,
    user: { id: user.id, role: user.role },
  });

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
          <p className="mt-2 max-w-[720px] text-[13.5px] leading-[1.55] text-mute">
            {t("sub")}
          </p>
        </div>
      </header>

      <form
        action="/runs"
        className="grid gap-3 rounded-[14px] border border-line bg-paper px-4 py-4 shadow-[var(--shadow-sm)] md:grid-cols-[minmax(160px,1.1fr)_minmax(140px,0.8fr)_minmax(140px,0.8fr)_minmax(120px,0.7fr)_minmax(132px,0.65fr)_minmax(132px,0.65fr)_auto]"
      >
        <FilterSelect
          label={t("filters.project")}
          name="project"
          value={filters.projectSlug ?? ""}
        >
          <option value="">{t("filters.allProjects")}</option>
          {page.projectOptions.map((project) => (
            <option key={project.id} value={project.slug}>
              {project.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label={t("filters.state")}
          name="status"
          value={filters.status ?? ""}
        >
          <option value="">{t("filters.allStates")}</option>
          {RUNS_LIST_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`status.${status}`)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label={t("filters.source")}
          name="source"
          value={filters.source ?? ""}
        >
          <option value="">{t("filters.allSources")}</option>
          {RUNS_LIST_SOURCES.map((source) => (
            <option key={source} value={source}>
              {t(`source.${source}`)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label={t("filters.runner")}
          name="agent"
          value={filters.agent ?? ""}
        >
          <option value="">{t("filters.allRunners")}</option>
          {ADAPTER_IDS.map((adapter) => (
            <option key={adapter} value={adapter}>
              {adapter}
            </option>
          ))}
        </FilterSelect>
        <FilterInput
          label={t("filters.from")}
          name="from"
          type="date"
          value={filters.dateFrom ?? ""}
        />
        <FilterInput
          label={t("filters.to")}
          name="to"
          type="date"
          value={filters.dateTo ?? ""}
        />
        <div className="flex items-end gap-2">
          <button
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-amber-line bg-amber-soft px-3 font-mono text-[11px] font-semibold text-amber transition-colors hover:border-amber hover:bg-paper"
            type="submit"
          >
            <FunnelIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {t("filters.apply")}
          </button>
          <Link
            className="inline-flex h-10 items-center rounded-lg border border-line bg-paper px-3 font-mono text-[11px] font-semibold text-mute transition-colors hover:border-mute hover:text-ink"
            href="/runs"
          >
            {t("filters.reset")}
          </Link>
        </div>
      </form>

      <section className="rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
              {t("table.title")}
            </h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              {t("table.sub", { count: page.rows.length })}
            </p>
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
            {t("page", { page: page.page })}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse text-left">
            <thead className="border-b border-line bg-ivory">
              <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                <th className="px-5 py-3">{t("table.run")}</th>
                <th className="px-4 py-3">{t("table.project")}</th>
                <th className="px-4 py-3">{t("table.state")}</th>
                <th className="px-4 py-3">{t("table.source")}</th>
                <th className="px-4 py-3">{t("table.started")}</th>
                <th className="px-4 py-3">{t("table.duration")}</th>
                <th className="px-4 py-3">{t("table.runner")}</th>
                <th className="px-5 py-3 text-right">{t("table.cost")}</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.length === 0 ? (
                <tr>
                  <td
                    className="px-5 py-10 text-center font-mono text-[11.5px] text-mute"
                    colSpan={8}
                  >
                    {t("table.empty")}
                  </td>
                </tr>
              ) : (
                page.rows.map((row) => (
                  <RunRow key={row.runId} locale={locale} row={row} t={t} />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          {page.page > 1 ? (
            <Link
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11px] font-semibold text-ink-2 transition-colors hover:border-mute hover:text-ink"
              href={pageHref(filters, page.page - 1)}
            >
              <ArrowLeftIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t("previous")}
            </Link>
          ) : (
            <span />
          )}
          {page.hasNextPage ? (
            <Link
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11px] font-semibold text-ink-2 transition-colors hover:border-mute hover:text-ink"
              href={pageHref(filters, page.page + 1)}
            >
              {t("next")}
              <ArrowRightIcon aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <span className="font-mono text-[10.5px] text-mute">
              {t("end")}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function FilterSelect({
  children,
  label,
  name,
  value,
}: {
  children: ReactNode;
  label: string;
  name: string;
  value: string;
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
        {label}
      </span>
      <select
        className="h-10 min-w-0 rounded-lg border border-line bg-ivory px-3 font-mono text-[11.5px] text-ink outline-none transition-colors focus:border-amber"
        defaultValue={value}
        name={name}
      >
        {children}
      </select>
    </label>
  );
}

function FilterInput({
  label,
  name,
  type,
  value,
}: {
  label: string;
  name: string;
  type: "date";
  value: string;
}): ReactElement {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
        {label}
      </span>
      <input
        className="h-10 min-w-0 rounded-lg border border-line bg-ivory px-3 font-mono text-[11.5px] text-ink outline-none transition-colors focus:border-amber"
        defaultValue={value}
        name={name}
        type={type}
      />
    </label>
  );
}

function RunRow({
  locale,
  row,
  t,
}: {
  locale: string;
  row: RunsListRow;
  t: Awaited<ReturnType<typeof getTranslations>>;
}): ReactElement {
  return (
    <tr className="border-b border-line align-middle last:border-b-0">
      <td className="px-5 py-3.5">
        <Link
          className="block max-w-[360px] truncate text-[12.5px] font-semibold text-ink underline-offset-2 hover:underline"
          href={row.href}
        >
          {row.taskLabel}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-mute">
          <span>{compactId(row.runId)}</span>
          {row.branch ? <span>· {row.branch}</span> : null}
          {row.flowLabel ? <span>· {row.flowLabel}</span> : null}
        </div>
      </td>
      <td className="px-4 py-3.5">
        <Link
          className="block max-w-[180px] truncate text-[12px] font-semibold text-ink-2 underline-offset-2 hover:underline"
          href={`/projects/${row.projectSlug}`}
        >
          {row.projectName}
        </Link>
      </td>
      <td className="px-4 py-3.5">
        <span
          className={clsx(
            "rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]",
            STATUS_TONE[row.status],
          )}
        >
          {t(`status.${row.status}`)}
        </span>
      </td>
      <td className="px-4 py-3.5">
        <div className="font-mono text-[11px] text-ink-2">
          {t(`source.${row.sourceKind}`)}
        </div>
        {row.sourceLabel ? (
          <div className="mt-1 max-w-[180px] truncate font-mono text-[10px] text-mute">
            {row.sourceLabel}
          </div>
        ) : null}
      </td>
      <td
        suppressHydrationWarning
        className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute"
      >
        {formatDateTime(locale, row.startedAt)}
      </td>
      <td className="px-4 py-3.5 font-mono text-[10.5px] tabular-nums text-mute">
        {formatDuration(row.durationMs)}
      </td>
      <td className="px-4 py-3.5">
        <div className="max-w-[220px] truncate font-mono text-[10.5px] text-ink-2">
          {row.runnerLabel ?? "—"}
        </div>
      </td>
      <td className="px-5 py-3.5 text-right font-mono text-[10.5px] tabular-nums text-mute">
        {row.tokensTotal === null
          ? "—"
          : t("tokens", { count: row.tokensTotal })}
      </td>
    </tr>
  );
}
