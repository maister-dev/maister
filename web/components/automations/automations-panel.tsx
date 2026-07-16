"use client";

import type { ReactElement, ReactNode } from "react";

import Link from "next/link";
import { useState } from "react";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

type AutomationType =
  | "one_time_task_launch"
  | "recurring_task_schedule"
  | "agent_cron"
  | "agent_event";

type AutomationFilter = AutomationType | "agent" | "all";

export type AutomationPanelRow = {
  id: string;
  type: AutomationType;
  name: string;
  target: string;
  trigger: string;
  timezone: string | null;
  nextActionAt: string | null;
  state: string;
  latestOutcome: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  lateByMs: number | null;
  resultingRun: { id: string; status: string } | null;
  detailHref: string;
  updatedAt: string;
};

type Labels = {
  all: string;
  agent: string;
  attention: string;
  cancel: string;
  cancelConfirm: string;
  cancelEdit: string;
  disambiguation: string;
  edit: string;
  earlier: string;
  empty: string;
  error: string;
  errorLabels: Record<string, string>;
  manageAgent: string;
  later: string;
  lateByOne: string;
  lateByOther: string;
  loadMore: string;
  loadingMore: string;
  oneTime: string;
  outcomeLabels: Record<string, string>;
  recurring: string;
  runNow: string;
  save: string;
  saving: string;
  scheduledLocalTime: string;
  stateLabels: Record<string, string>;
  timezone: string;
  title: string;
  viewRun: string;
};

type ScheduledLaunchDetail = {
  intent: {
    id: string;
    revision: number;
    scheduledLocalTime: string;
    timezone: string;
    disambiguation: "earlier" | "later" | null;
    launchRequest: Record<string, unknown>;
  };
};

type ScheduledLaunchEdit = ScheduledLaunchDetail["intent"] & {
  etag: string;
};

function isMutableOneTimeLaunch(row: AutomationPanelRow): boolean {
  return (
    row.type === "one_time_task_launch" &&
    (row.state === "Scheduled" || row.state === "RetryWaiting")
  );
}

function localizedValue(
  labels: Record<string, string>,
  value: string | null,
): string | null {
  if (value === null) return null;

  return labels[value] ?? value;
}

function lateMinutes(lateByMs: number): number {
  return Math.max(1, Math.ceil(lateByMs / 60_000));
}

function formatLateBy(input: {
  one: string;
  other: string;
  minutes: number;
}): string {
  const template = input.minutes === 1 ? input.one : input.other;

  return template.replace("__MINUTES__", String(input.minutes));
}

export function AutomationsPanel(props: {
  canManage: boolean;
  children?: ReactNode;
  initialNextCursor: string | null;
  initialRows: AutomationPanelRow[];
  labels: Labels;
  slug: string;
}): ReactElement {
  const [rows, setRows] = useState(props.initialRows);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<AutomationPanelRow | null>(null);
  const [editing, setEditing] = useState<ScheduledLaunchEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AutomationFilter>("all");
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(props.initialNextCursor);
  const visibleRows = rows.filter(
    (row) =>
      filter === "all" ||
      filter === row.type ||
      (filter === "agent" &&
        (row.type === "agent_cron" || row.type === "agent_event")),
  );

  async function fetchPage(cursor?: string): Promise<{
    nextCursor: string | null;
    rows: AutomationPanelRow[];
  }> {
    const query = new URLSearchParams({ limit: "50" });

    if (cursor) query.set("cursor", cursor);

    const response = await fetch(
      `/api/projects/${encodeURIComponent(props.slug)}/automations?${query.toString()}`,
    );

    if (!response.ok) throw new Error("automation refresh failed");

    const body = (await response.json()) as {
      nextCursor?: string | null;
      rows?: AutomationPanelRow[];
    };

    return {
      nextCursor: body.nextCursor ?? null,
      rows: body.rows ?? [],
    };
  }

  async function refresh(): Promise<void> {
    const page = await fetchPage();

    setRows(page.rows);
    setNextCursor(page.nextCursor);
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || isLoadingMore) return;

    setError(null);
    setIsLoadingMore(true);

    try {
      const page = await fetchPage(nextCursor);

      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.nextCursor);
    } catch {
      setError(props.labels.error);
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function mutate(
    row: AutomationPanelRow,
    action: "cancel" | "run-now",
  ): Promise<boolean> {
    setBusyId(row.id);
    setError(null);

    try {
      const detail = await fetch(
        `/api/projects/${encodeURIComponent(props.slug)}/scheduled-launches/${encodeURIComponent(row.id)}`,
      );
      const etag = detail.headers.get("ETag");

      if (!detail.ok || !etag) {
        throw new Error("automation revision unavailable");
      }

      const response = await fetch(
        `/api/projects/${encodeURIComponent(props.slug)}/scheduled-launches/${encodeURIComponent(row.id)}/${action}`,
        { method: "POST", headers: { "If-Match": etag } },
      );

      if (!response.ok) throw new Error("automation mutation failed");

      await refresh();

      return true;
    } catch {
      setError(props.labels.error);

      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function confirmCancellation(): Promise<void> {
    if (!cancelling) return;

    const cancelled = await mutate(cancelling, "cancel");

    if (cancelled) setCancelling(null);
  }

  function closeCancellation(): void {
    if (busyId === cancelling?.id) return;

    setCancelling(null);
    setError(null);
  }

  async function beginEdit(row: AutomationPanelRow): Promise<void> {
    setBusyId(row.id);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(props.slug)}/scheduled-launches/${encodeURIComponent(row.id)}`,
      );
      const etag = response.headers.get("ETag");

      if (!response.ok || !etag) {
        throw new Error("automation revision unavailable");
      }

      const body = (await response.json()) as ScheduledLaunchDetail;

      setEditing({ ...body.intent, etag });
    } catch {
      setError(props.labels.error);
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return;

    setBusyId(editing.id);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(props.slug)}/scheduled-launches/${encodeURIComponent(editing.id)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "If-Match": editing.etag,
          },
          body: JSON.stringify({
            scheduledLocalTime: editing.scheduledLocalTime,
            timezone: editing.timezone,
            ...(editing.disambiguation
              ? { disambiguation: editing.disambiguation }
              : {}),
            launchRequest: editing.launchRequest,
          }),
        },
      );

      if (!response.ok) {
        throw new Error("automation update failed");
      }

      setEditing(null);
      await refresh();
    } catch {
      setError(props.labels.error);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-6" aria-label={props.labels.title}>
      <div className="rounded-[12px] border border-line bg-paper p-5">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-[18px] font-semibold text-ink">{props.labels.title}</h2>
        </div>
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={props.labels.title}>
          {([
            ["all", props.labels.all],
            ["one_time_task_launch", props.labels.oneTime],
            ["recurring_task_schedule", props.labels.recurring],
            ["agent", props.labels.agent],
          ] as const).map(([value, label]) => (
            <button
              aria-pressed={filter === value}
              className="rounded border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase text-ink hover:border-amber aria-pressed:border-amber aria-pressed:text-amber"
              key={value}
              type="button"
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {error && !cancelling ? (
          <p aria-live="polite" className="mb-3 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700" role="alert">
            {error}
          </p>
        ) : null}
        {editing ? (
          <form
            className="mb-4 grid gap-3 rounded-[8px] border border-amber-line bg-amber-soft p-3 md:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute">
                {props.labels.scheduledLocalTime}
              </span>
              <input
                className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                type="datetime-local"
                value={editing.scheduledLocalTime}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    scheduledLocalTime: event.target.value,
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute">
                {props.labels.timezone}
              </span>
              <input
                className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                value={editing.timezone}
                onChange={(event) =>
                  setEditing({ ...editing, timezone: event.target.value })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute">
                {props.labels.disambiguation}
              </span>
              <select
                className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                value={editing.disambiguation ?? "later"}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    disambiguation: event.target.value as "earlier" | "later",
                  })
                }
              >
                <option value="earlier">{props.labels.earlier}</option>
                <option value="later">{props.labels.later}</option>
              </select>
            </label>
            <div className="flex items-end justify-end gap-2">
              <button
                className="rounded border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase text-ink hover:border-amber"
                disabled={busyId === editing.id}
                type="button"
                onClick={() => setEditing(null)}
              >
                {props.labels.cancelEdit}
              </button>
              <button
                className="rounded border border-amber bg-amber px-2 py-1 font-mono text-[10px] font-bold uppercase text-white hover:bg-amber-2"
                disabled={busyId === editing.id}
                type="submit"
              >
                {busyId === editing.id ? props.labels.saving : props.labels.save}
              </button>
            </div>
          </form>
        ) : null}
        {visibleRows.length === 0 ? (
          <p className="font-mono text-[12px] text-mute">{props.labels.empty}</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {visibleRows.map((row) => (
              <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={`${row.type}:${row.id}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{row.name}</p>
                  <p className="font-mono text-[11px] text-mute">
                    {row.target} · {row.trigger}
                    {row.timezone ? ` · ${row.timezone}` : ""}
                  </p>
                  <p className="font-mono text-[10px] text-mute">
                    {localizedValue(props.labels.stateLabels, row.state)}
                    {row.latestOutcome
                      ? ` · ${localizedValue(props.labels.outcomeLabels, row.latestOutcome)}`
                      : ""}
                    {row.errorCode
                      ? ` · ${localizedValue(props.labels.errorLabels, row.errorCode)}`
                      : row.errorMessage
                        ? ` · ${props.labels.attention}`
                        : ""}
                  </p>
                  {row.lateByMs !== null && row.lateByMs > 0 ? (
                    <p className="font-mono text-[10px] text-amber">
                      {formatLateBy(
                        {
                          one: props.labels.lateByOne,
                          other: props.labels.lateByOther,
                          minutes: lateMinutes(row.lateByMs),
                        },
                      )}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {isMutableOneTimeLaunch(row) && props.canManage ? (
                    <>
                      <button
                        className="rounded border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase text-ink hover:border-amber"
                        disabled={busyId === row.id}
                        type="button"
                        onClick={() => void mutate(row, "run-now")}
                      >
                        {props.labels.runNow}
                      </button>
                      <button
                        className="rounded border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase text-ink hover:border-amber"
                        disabled={busyId === row.id}
                        type="button"
                        onClick={() => void beginEdit(row)}
                      >
                        {props.labels.edit}
                      </button>
                      <button
                        className="rounded border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase text-ink hover:border-red-500"
                        disabled={busyId === row.id}
                        type="button"
                        onClick={() => {
                          setError(null);
                          setCancelling(row);
                        }}
                      >
                        {props.labels.cancel}
                      </button>
                    </>
                  ) : null}
                  {row.type === "agent_cron" || row.type === "agent_event" ? (
                    <Link
                      className="font-mono text-[10px] font-bold uppercase text-amber hover:underline"
                      href={`/projects/${props.slug}?tab=agents`}
                    >
                      {props.labels.manageAgent}
                    </Link>
                  ) : null}
                  {row.resultingRun ? (
                    <Link
                      className="font-mono text-[10px] font-bold uppercase text-amber hover:underline"
                      href={`/runs/${encodeURIComponent(row.resultingRun.id)}`}
                    >
                      {props.labels.viewRun}
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextCursor ? (
          <div className="mt-4 flex justify-end">
            <button
              className="rounded border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase text-ink hover:border-amber"
              disabled={isLoadingMore}
              type="button"
              onClick={() => void loadMore()}
            >
              {isLoadingMore ? props.labels.loadingMore : props.labels.loadMore}
            </button>
          </div>
        ) : null}
      </div>
      {cancelling ? (
        <ConfirmDialog
          body={props.labels.cancelConfirm}
          busy={busyId === cancelling.id}
          cancelLabel={props.labels.cancelEdit}
          testId="automation-cancel-confirm"
          title={props.labels.cancel}
          titleId="automation-cancel-confirm-title"
          onClose={closeCancellation}
        >
          {error ? (
            <p
              aria-live="assertive"
              className="rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              className="rounded border border-line px-2 py-1 font-mono text-[10px] font-bold uppercase text-ink hover:border-amber"
              disabled={busyId === cancelling.id}
              type="button"
              onClick={closeCancellation}
            >
              {props.labels.cancelEdit}
            </button>
            <button
              className="rounded border border-red-500 px-2 py-1 font-mono text-[10px] font-bold uppercase text-red-700 hover:bg-red-50"
              data-testid="automation-cancel-confirm-submit"
              disabled={busyId === cancelling.id}
              type="button"
              onClick={() => void confirmCancellation()}
            >
              {props.labels.cancel}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
      {props.children}
    </section>
  );
}
