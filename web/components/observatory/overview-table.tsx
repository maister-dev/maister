import type { DeliveryRunKind } from "@/lib/observatory/run-kind";
import type { OverviewRow } from "@/lib/queries/observatory-overview";
import type { OverviewTableProps } from "@/components/observatory/types";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import { DELIVERY_RUN_KINDS } from "@/lib/observatory/run-kind";
import { runsLedgerHref } from "@/lib/observatory/drilldown";
import {
  IN_FLIGHT_OUTCOME_BUCKETS,
  SETTLED_OUTCOME_BUCKETS,
} from "@/lib/runs/outcome-bucket";

/**
 * The Observatory overview table (ADR-177 D2/D3/D4).
 *
 * One scroll container, NO responsive column dropping: a table that hides
 * columns at a breakpoint has to keep a `<th>` and a `<td>` rule in step at
 * every width, and they drift. One `overflow-x-auto` with a `min-w` keeps the
 * page itself from scrolling sideways instead.
 */
export function OverviewTable({
  table,
  labels,
  current,
  projectSlug,
  liveLabel,
}: OverviewTableProps): ReactElement {
  const rows = [...table.rows, ...table.subRows];
  const isEmpty =
    rows.length === 0 ||
    DELIVERY_RUN_KINDS.every((kind) => table.totals.runs[kind] === 0);

  return (
    <section
      className="rounded-[14px] border border-line bg-paper"
      data-testid="observatory-overview"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="m-0 text-lg font-semibold text-ink">
            {labels.overview.title}
          </h2>
          <p className="mt-1 max-w-[72ch] text-sm text-mute">
            {labels.overview.subtitle}
          </p>
        </div>
        {liveLabel ? (
          <span
            className="rounded-full border border-amber-line bg-amber-soft px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-amber"
            data-testid="observatory-overview-live"
          >
            {liveLabel}
          </span>
        ) : null}
      </header>

      {isEmpty ? (
        <p className="m-0 px-5 py-10 text-center font-mono text-[11.5px] text-mute">
          {labels.overview.empty}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-ivory font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
                <th className="px-5 py-2" rowSpan={2}>
                  {labels.overview.project}
                </th>
                <th className="border-l border-line px-3 py-2" colSpan={2}>
                  {labels.overview.tasks}
                </th>
                <th className="border-l border-line px-3 py-2" colSpan={3}>
                  {labels.overview.runs}
                </th>
                <th
                  className="border-l border-line px-3 py-2"
                  colSpan={IN_FLIGHT_OUTCOME_BUCKETS.length}
                >
                  {labels.overview.inFlight}
                </th>
                <th
                  className="border-l border-line px-3 py-2"
                  colSpan={SETTLED_OUTCOME_BUCKETS.length}
                >
                  {labels.overview.settled}
                </th>
              </tr>
              <tr className="border-b border-line bg-ivory font-mono text-[9.5px] uppercase tracking-[0.08em] text-mute">
                <th className="border-l border-line px-3 py-2 text-right">
                  {labels.overview.tasksInWork}
                </th>
                <th className="px-3 py-2 text-right">
                  {labels.overview.tasksStarted}
                </th>
                {DELIVERY_RUN_KINDS.map((kind, index) => (
                  <th
                    key={kind}
                    className={clsx(
                      "px-3 py-2 text-right",
                      index === 0 && "border-l border-line",
                    )}
                  >
                    {labels.overview.kind[kind]}
                  </th>
                ))}
                {IN_FLIGHT_OUTCOME_BUCKETS.map((bucket, index) => (
                  <th
                    key={bucket}
                    className={clsx(
                      "px-3 py-2 text-right",
                      index === 0 && "border-l border-line",
                    )}
                  >
                    {labels.bucket[bucket]}
                  </th>
                ))}
                {SETTLED_OUTCOME_BUCKETS.map((bucket, index) => (
                  <th
                    key={bucket}
                    className={clsx(
                      "px-3 py-2 text-right",
                      index === 0 && "border-l border-line",
                    )}
                  >
                    {labels.bucket[bucket]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <Row
                  key={row.key}
                  current={current}
                  labels={labels}
                  projectSlug={projectSlug}
                  row={row}
                />
              ))}
              {table.subRows.map((row) => (
                <Row
                  key={row.key}
                  indented
                  current={current}
                  labels={labels}
                  projectSlug={projectSlug}
                  row={row}
                />
              ))}
              {table.platform ? (
                <Row
                  current={current}
                  labels={labels}
                  projectSlug={projectSlug}
                  row={table.platform}
                />
              ) : null}
              <tr
                className="border-t-2 border-line bg-ivory font-semibold"
                data-testid="observatory-overview-total"
              >
                <th className="px-5 py-3 text-left text-[12.5px] text-ink">
                  {labels.overview.total}
                </th>
                <Cell bordered value={table.totals.tasksInWork} />
                <Cell value={table.totals.tasksStarted} />
                {DELIVERY_RUN_KINDS.map((kind, index) => (
                  <Cell
                    key={kind}
                    bordered={index === 0}
                    value={table.totals.runs[kind]}
                  />
                ))}
                {[...IN_FLIGHT_OUTCOME_BUCKETS, ...SETTLED_OUTCOME_BUCKETS].map(
                  (bucket, index) => (
                    <Cell
                      key={bucket}
                      bordered={
                        index === 0 ||
                        index === IN_FLIGHT_OUTCOME_BUCKETS.length
                      }
                      value={table.totals.buckets[bucket]}
                    />
                  ),
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Row({
  current,
  indented,
  labels,
  projectSlug,
  row,
}: {
  current: OverviewTableProps["current"];
  indented?: boolean;
  labels: OverviewTableProps["labels"];
  projectSlug?: string;
  row: OverviewRow;
}): ReactElement {
  // D4: the Platform row aggregates project-less runs, which belong to no
  // board — its task cells stay empty rather than showing a misleading zero.
  const isPlatform = row.identity.kind === "platform";
  const slug =
    row.identity.kind === "project" ? row.identity.projectSlug : projectSlug;
  // A run-kind sub-row narrows the ledger exactly (`kind=`), so its cells stay
  // links. A FLOW sub-row does not: the ledger has no flow filter, so a link
  // would open a list holding every flow's runs in that bucket — a count that
  // disagrees with the cell it came from. AC4 says a cell's count equals the
  // list it opens, so a flow sub-row's cells open nothing.
  const kindFilter: DeliveryRunKind | undefined =
    row.identity.kind === "runKind" ? row.identity.runKind : undefined;
  const linkable = row.identity.kind !== "flow";

  return (
    <tr className="border-b border-line last:border-b-0">
      <th
        className={clsx(
          "px-5 py-3 text-left text-[12.5px] font-semibold text-ink",
          indented && "pl-9 font-normal text-ink-2",
        )}
        scope="row"
      >
        <RowName labels={labels} row={row} slug={slug} />
      </th>
      <Cell
        bordered
        href={isPlatform || !slug ? undefined : `/projects/${slug}`}
        value={isPlatform ? null : row.counts.tasksInWork}
      />
      <Cell
        href={isPlatform || !slug ? undefined : `/projects/${slug}`}
        value={isPlatform ? null : row.counts.tasksStarted}
      />
      {DELIVERY_RUN_KINDS.map((kind, index) => (
        <Cell
          key={kind}
          bordered={index === 0}
          href={
            linkable
              ? runsLedgerHref({
                  projectSlug: isPlatform ? undefined : slug,
                  period: current.period,
                  kind,
                })
              : undefined
          }
          title={labels.overview.openInLedger}
          value={row.counts.runs[kind]}
        />
      ))}
      {[...IN_FLIGHT_OUTCOME_BUCKETS, ...SETTLED_OUTCOME_BUCKETS].map(
        (bucket, index) => (
          <Cell
            key={bucket}
            bordered={index === 0 || index === IN_FLIGHT_OUTCOME_BUCKETS.length}
            href={
              linkable
                ? runsLedgerHref({
                    projectSlug: isPlatform ? undefined : slug,
                    period: current.period,
                    kind: kindFilter,
                    bucket,
                  })
                : undefined
            }
            title={labels.overview.openInLedger}
            value={row.counts.buckets[bucket]}
          />
        ),
      )}
    </tr>
  );
}

function RowName({
  labels,
  row,
  slug,
}: {
  labels: OverviewTableProps["labels"];
  row: OverviewRow;
  slug?: string;
}): ReactElement {
  if (row.identity.kind === "platform") {
    return <span>{labels.overview.platform}</span>;
  }
  if (row.identity.kind === "flow") {
    return <span className="font-mono">{row.identity.flowRefId}</span>;
  }
  if (row.identity.kind === "runKind") {
    return <span>{labels.overview.kind[row.identity.runKind]}</span>;
  }

  return (
    <Link
      className="underline-offset-2 hover:underline"
      href={`/projects/${slug ?? row.identity.projectSlug}`}
    >
      {row.identity.projectName}
    </Link>
  );
}

function Cell({
  bordered,
  href,
  title,
  value,
}: {
  bordered?: boolean;
  href?: string;
  title?: string;
  value: number | null;
}): ReactElement {
  return (
    <td
      className={clsx(
        "px-3 py-3 text-right font-mono text-[12px] tabular-nums",
        bordered && "border-l border-line",
        value === null || value === 0 ? "text-mute" : "text-ink",
      )}
    >
      {value === null ? (
        "—"
      ) : href ? (
        <Link
          className="underline-offset-2 hover:underline"
          href={href}
          title={title}
        >
          {value}
        </Link>
      ) : (
        value
      )}
    </td>
  );
}
