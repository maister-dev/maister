import type { ReactElement } from "react";

import Link from "next/link";

import type { TaskActivityLogRow } from "@/lib/queries/activity";

export interface TaskActivityLogLabels {
  title: string;
  empty: string;
  colWhen: string;
  colTask: string;
  colEvent: string;
  colActor: string;
  colDetails: string;
  filterActor: string;
  filterEvent: string;
  filterTask: string;
  filterAny: string;
  apply: string;
  pagePrev: string;
  pageNext: string;
  pageInfo: string;
  formerUser: string;
  system: string;
  eventKind: Record<string, string>;
}

const ACTOR_TYPES = ["user", "agent", "system"] as const;
const EVENT_KINDS = [
  "task_created",
  "comment_added",
  "task_mentioned",
  "relation_added",
  "relation_removed",
  "run_launched",
] as const;

function detailsOf(row: TaskActivityLogRow): string {
  const payload = row.payload;

  if (typeof payload.toRef === "string") return `→ ${payload.toRef}`;
  if (typeof payload.fromKey === "string") return `← ${payload.fromKey}`;
  if (typeof payload.attemptNumber === "number")
    return `#${payload.attemptNumber}`;

  return "";
}

// Read-only view-table per the admin convention (canonical:
// scheduler-jobs-table): no inline edits; filters + pagination are
// URL-synchronized GET params on the activity tab.
export function TaskActivityLog({
  slug,
  rows,
  total,
  page,
  pageSize,
  filters,
  labels,
}: {
  slug: string;
  rows: TaskActivityLogRow[];
  total: number;
  page: number;
  pageSize: number;
  filters: { actorType?: string; eventKind?: string; task?: string };
  labels: TaskActivityLogLabels;
}): ReactElement {
  const pages = Math.max(Math.ceil(total / pageSize), 1);

  const pageHref = (target: number): string => {
    const params = new URLSearchParams({ tab: "activity" });

    if (filters.actorType) params.set("actor_type", filters.actorType);
    if (filters.eventKind) params.set("event_kind", filters.eventKind);
    if (filters.task) params.set("task", filters.task);
    if (target > 1) params.set("page", String(target));

    return `/projects/${slug}?${params.toString()}`;
  };

  return (
    <section className="mt-6 flex flex-col gap-3">
      <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-mute">
        {labels.title}
      </h2>

      <form
        action={`/projects/${slug}`}
        className="flex flex-wrap items-center gap-2 font-mono text-[11px]"
        method="get"
      >
        <input name="tab" type="hidden" value="activity" />
        <label className="flex items-center gap-1 text-mute">
          {labels.filterActor}
          <select
            className="rounded border border-line bg-paper px-1.5 py-1 text-ink"
            defaultValue={filters.actorType ?? ""}
            name="actor_type"
          >
            <option value="">{labels.filterAny}</option>
            {ACTOR_TYPES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-mute">
          {labels.filterEvent}
          <select
            className="rounded border border-line bg-paper px-1.5 py-1 text-ink"
            defaultValue={filters.eventKind ?? ""}
            name="event_kind"
          >
            <option value="">{labels.filterAny}</option>
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {labels.eventKind[k] ?? k}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-mute">
          {labels.filterTask}
          <input
            className="w-24 rounded border border-line bg-paper px-1.5 py-1 text-ink"
            defaultValue={filters.task ?? ""}
            name="task"
            placeholder="KEY-N"
          />
        </label>
        <button
          className="rounded border border-line bg-paper px-2 py-1 uppercase tracking-[0.06em] text-mute transition hover:border-amber hover:text-amber"
          type="submit"
        >
          {labels.apply}
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-[12px] text-mute">{labels.empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] text-left font-mono text-[11.5px]">
            <thead>
              <tr className="border-b border-line bg-ivory text-[10.5px] uppercase tracking-[0.08em] text-mute">
                <th className="px-3 py-2 font-semibold">{labels.colWhen}</th>
                <th className="px-3 py-2 font-semibold">{labels.colTask}</th>
                <th className="px-3 py-2 font-semibold">{labels.colEvent}</th>
                <th className="px-3 py-2 font-semibold">{labels.colActor}</th>
                <th className="px-3 py-2 font-semibold">{labels.colDetails}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line-soft">
                  <td className="px-3 py-1.5 text-mute" suppressHydrationWarning>
                    {row.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="px-3 py-1.5">
                    <Link
                      className="font-semibold text-amber hover:underline"
                      href={`/projects/${slug}/tasks/${row.taskNumber}`}
                      title={row.taskTitle}
                    >
                      {row.keyRef}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">
                    {labels.eventKind[row.eventKind] ?? row.eventKind}
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">
                    {row.actor.type === "system"
                      ? labels.system
                      : row.actor.label === "former user"
                        ? labels.formerUser
                        : row.actor.label}
                  </td>
                  <td className="px-3 py-1.5 text-mute">{detailsOf(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <div className="flex items-center gap-3 font-mono text-[11px] text-mute">
          {page > 1 ? (
            <Link className="hover:text-amber" href={pageHref(page - 1)}>
              {labels.pagePrev}
            </Link>
          ) : null}
          <span>
            {labels.pageInfo.replace("{page}", String(page)).replace(
              "{pages}",
              String(pages),
            )}
          </span>
          {page < pages ? (
            <Link className="hover:text-amber" href={pageHref(page + 1)}>
              {labels.pageNext}
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
