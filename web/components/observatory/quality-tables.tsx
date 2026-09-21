import type {
  ObservatoryFlowSummary,
  ObservatoryProjectSummary,
} from "@/lib/queries/observatory";
import type { ObservatoryLabels } from "@/components/observatory/types";
import type { ObservatoryPeriod } from "@/lib/observatory/period";
import type { ObservatoryRunKind } from "@/lib/observatory/run-kind";
import type { ReactElement, ReactNode } from "react";

import Link from "next/link";

import { formatSeconds } from "@/components/observatory/harness-format";
import { observatoryDrilldownHref } from "@/lib/observatory/href";

// ADR-178 D6: `getPortfolioObservatory` has always computed `projects[]` and
// `flows[]` and nothing rendered them. The Quality view is where they belong —
// correction pressure and autonomy side by side, per project or per flow.

interface QualityRow {
  key: string;
  name: ReactNode;
  flowRuns: number;
  rework: number;
  retries: number;
  correctionRate: number;
  autonomy: number;
  waitSeconds: number;
  volatile: boolean;
}

export function QualityProjectsTable({
  labels,
  period,
  projects,
  runKind,
}: {
  labels: ObservatoryLabels;
  /** ADR-178: the row link opens the SAME window the reader is looking at. */
  period: ObservatoryPeriod;
  projects: readonly ObservatoryProjectSummary[];
  runKind: ObservatoryRunKind;
}): ReactElement {
  return (
    <QualityTable
      labels={labels}
      nameHeader={labels.quality.project}
      rows={projects.map((project) => ({
        key: project.projectId,
        name: (
          <Link
            className="underline-offset-2 hover:underline"
            href={observatoryDrilldownHref(
              `/projects/${project.projectSlug}/observatory`,
              { period, runKind, view: "quality" },
            )}
          >
            {project.projectName}
          </Link>
        ),
        ...metrics(project),
      }))}
      testId="observatory-quality-projects"
      title={labels.quality.projectsTitle}
    />
  );
}

export function QualityFlowsTable({
  flows,
  labels,
}: {
  flows: readonly ObservatoryFlowSummary[];
  labels: ObservatoryLabels;
}): ReactElement {
  return (
    <QualityTable
      labels={labels}
      nameHeader={labels.quality.flow}
      rows={flows.map((flow) => ({
        key: flow.flowId,
        name: <span className="font-mono">{flow.flowRefId}</span>,
        ...metrics(flow),
      }))}
      testId="observatory-quality-flows"
      title={labels.quality.flowsTitle}
    />
  );
}

function metrics(
  summary: ObservatoryProjectSummary | ObservatoryFlowSummary,
): Omit<QualityRow, "key" | "name"> {
  return {
    flowRuns: summary.correction.runCount,
    rework: summary.correction.reworkCount,
    retries: summary.correction.retryCount,
    correctionRate: summary.correction.correctionRate,
    autonomy: summary.autonomy.autonomyScore,
    waitSeconds: summary.autonomy.waitSeconds,
    volatile: summary.autonomy.volatile || summary.correction.volatile,
  };
}

function QualityTable({
  labels,
  nameHeader,
  rows,
  testId,
  title,
}: {
  labels: ObservatoryLabels;
  nameHeader: string;
  rows: readonly QualityRow[];
  testId: string;
  title: string;
}): ReactElement {
  return (
    <section
      className="rounded-lg border border-line bg-paper"
      data-testid={testId}
    >
      <header className="border-b border-line px-4 py-3">
        <h2 className="m-0 text-sm font-semibold text-ink">{title}</h2>
      </header>
      {rows.length === 0 ? (
        <p className="m-0 px-4 py-6 text-sm text-mute">{labels.noNodes}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-ivory font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
                <th className="px-4 py-2">{nameHeader}</th>
                <th className="px-3 py-2 text-right">
                  {labels.quality.flowRuns}
                </th>
                <th className="px-3 py-2 text-right">{labels.rework}</th>
                <th className="px-3 py-2 text-right">{labels.retries}</th>
                <th className="px-3 py-2 text-right">
                  {labels.correctionRate}
                </th>
                <th className="px-3 py-2 text-right">{labels.autonomyScore}</th>
                <th className="px-4 py-2 text-right">{labels.quality.wait}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-line last:border-b-0"
                >
                  <th
                    className="px-4 py-2.5 text-left text-[12.5px] font-semibold text-ink"
                    scope="row"
                  >
                    {row.name}
                    {row.volatile ? (
                      <span className="ml-2 rounded-full border border-amber-line bg-amber-soft px-1.5 py-px font-mono text-[9px] font-bold uppercase text-amber">
                        {labels.volatile}
                      </span>
                    ) : null}
                  </th>
                  <Num value={String(row.flowRuns)} />
                  <Num value={String(row.rework)} />
                  <Num value={String(row.retries)} />
                  <Num value={row.correctionRate.toFixed(2)} />
                  <Num value={row.autonomy.toFixed(2)} />
                  <Num value={formatSeconds(row.waitSeconds)} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Num({ value }: { value: string }): ReactElement {
  return (
    <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-2">
      {value}
    </td>
  );
}
