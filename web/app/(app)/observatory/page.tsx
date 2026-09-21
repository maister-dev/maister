import type { ObservatoryLabels } from "@/components/observatory/types";
import type { ObservatoryPortfolio } from "@/lib/queries/observatory";
import type { ObservatorySearchParams } from "@/lib/observatory/filters";
import type { ReactElement } from "react";

import { getLocale, getTranslations } from "next-intl/server";

import { BudgetSurfaceCard } from "@/components/observatory/budget-surface-card";
import { ControlEffectivenessCard } from "@/components/observatory/control-effectiveness-card";
import { CostBreakdownCard } from "@/components/observatory/cost-breakdown-card";
import { CostKindBreakdown } from "@/components/observatory/cost-kind-breakdown";
import { CoverageMapCard } from "@/components/observatory/coverage-map-card";
import { labelsFromTranslations } from "@/components/observatory/labels";
import { ObservatoryFilterBar } from "@/components/observatory/observatory-filter-bar";
import { ObservatorySummary } from "@/components/observatory/observatory-summary";
import { ObservatoryViews } from "@/components/observatory/observatory-views";
import { OverviewCostStrip } from "@/components/observatory/overview-cost-strip";
import { OverviewTable } from "@/components/observatory/overview-table";
import { QualityProjectsTable } from "@/components/observatory/quality-tables";
import { SensorFiringCard } from "@/components/observatory/sensor-firing-card";
import {
  FlowLedgerNotApplicable,
  FlowLedgerScope,
} from "@/components/observatory/flow-ledger-scope";
import { requireSession } from "@/lib/authz";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";
import { isFlowLedgerApplicable } from "@/lib/observatory/run-kind";
import { getPortfolioObservatory } from "@/lib/queries/observatory";
import { getVisibleProjects } from "@/lib/queries/visible-projects";

const PATHNAME = "/observatory";

interface PageProps {
  searchParams: Promise<ObservatorySearchParams>;
}

function formatTokens(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export default async function ObservatoryPage({
  searchParams,
}: PageProps): Promise<ReactElement> {
  const user = await requireSession();
  const [t, tBucket, locale] = await Promise.all([
    getTranslations("observatory"),
    getTranslations("runBucket"),
    getLocale(),
  ]);
  const { filters, current } = parseObservatorySearchParams(await searchParams);
  const [data, visibleProjects] = await Promise.all([
    getPortfolioObservatory(user.id, user.role, filters),
    getVisibleProjects(user.id, user.role),
  ]);
  const labels = labelsFromTranslations(t, tBucket);
  // The select's options come from their OWN read, not from `overview.rows`:
  // a `project=` filter narrows those rows to one, and sourcing the options
  // from them would strand the reader on the project they just picked.
  //
  // D7: an unknown slug is dropped from the bar rather than shown as a
  // selection the page did not honour.
  const projectOptions = [...visibleProjects]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => ({ slug: project.slug, name: project.name }));
  const resolvedProject = projectOptions.some(
    (project) => project.slug === current.project,
  )
    ? current.project
    : undefined;
  const barCurrent = { ...current, project: resolvedProject };

  return (
    <>
      <header className="mb-6 border-b border-line pb-5">
        <div className="mb-2 inline-flex items-center gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("eyebrow")}
        </div>
        <h1 className="m-0 text-[32px] font-semibold leading-[1.1] text-ink">
          {labels.title}
        </h1>
        <p className="mt-2 max-w-[60ch] text-sm leading-6 text-body">
          {labels.subtitle}
        </p>
      </header>

      <ObservatoryFilterBar
        current={barCurrent}
        labels={labels}
        pathname={PATHNAME}
        projectOptions={projectOptions}
      />
      <ObservatoryViews
        current={barCurrent}
        labels={labels}
        pathname={PATHNAME}
      />

      {current.view === "overview" ? (
        <>
          <OverviewTable
            current={barCurrent}
            labels={labels}
            liveLabel={
              data.overview.volatile
                ? t("overview.liveHint", { count: inFlightCount(data) })
                : null
            }
            table={data.overview}
          />
          <OverviewCostStrip
            cost={data.cost}
            current={barCurrent}
            labels={labels}
            locale={locale}
            pathname={PATHNAME}
          />
        </>
      ) : null}

      {current.view === "cost" ? (
        <CostView data={data} labels={labels} locale={locale} t={t} />
      ) : null}

      {current.view === "quality" ? (
        isFlowLedgerApplicable(current.runKind) ? (
          <div className="grid grid-cols-1 items-start gap-4">
            <ObservatorySummary
              data={data}
              labels={labels}
              period={current.period}
              runKind={current.runKind}
            />
            <QualityProjectsTable labels={labels} projects={data.projects} />
          </div>
        ) : (
          <FlowLedgerNotApplicable labels={labels} />
        )
      ) : null}

      {current.view === "harness" ? (
        isFlowLedgerApplicable(current.runKind) ? (
          <section>
            <header className="mb-3">
              <h2 className="m-0 text-lg font-semibold text-ink">
                {labels.harness.sectionTitle}
              </h2>
              <FlowLedgerScope labels={labels} />
              <p className="mt-1 max-w-[72ch] text-sm text-mute">
                {labels.harness.sectionSubtitle}
              </p>
            </header>
            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
              <SensorFiringCard
                firing={data.harness.firing}
                labels={labels}
                neverFired={data.harness.neverFired}
                period={current.period}
                runKind={current.runKind}
              />
              <ControlEffectivenessCard
                effectiveness={data.harness.effectiveness}
                labels={labels}
              />
              <CoverageMapCard
                coverage={data.harness.coverage}
                labels={labels}
              />
            </div>
          </section>
        ) : (
          <FlowLedgerNotApplicable labels={labels} />
        )
      ) : null}
    </>
  );
}

function inFlightCount(data: ObservatoryPortfolio): number {
  return (
    data.overview.totals.buckets.Queued +
    data.overview.totals.buckets.Executing +
    data.overview.totals.buckets.WaitingOnHuman +
    data.overview.totals.buckets.Review +
    data.overview.totals.buckets.Crashed
  );
}

function CostView({
  data,
  labels,
  locale,
  t,
}: {
  data: ObservatoryPortfolio;
  labels: ObservatoryLabels;
  locale: string;
  t: Awaited<ReturnType<typeof getTranslations>>;
}): ReactElement {
  return (
    <section
      className="rounded-[14px] border border-line bg-paper p-5"
      data-testid="observatory-cost"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold text-ink">
            {t("cost.title")}
          </h2>
          <p className="mt-1 max-w-[72ch] text-sm text-mute">
            {t("cost.subtitle")}
          </p>
          <p className="mt-1 max-w-[72ch] text-sm text-mute">
            {t("cost.periodScoped")}
          </p>
        </div>
        <span className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute">
          {t("cost.readOnly")}
        </span>
      </div>
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        {[
          [t("cost.inputTokens"), formatTokens(locale, data.cost.inputTokens)],
          [
            t("cost.outputTokens"),
            formatTokens(locale, data.cost.outputTokens),
          ],
          [
            t("cost.cacheTokens"),
            formatTokens(
              locale,
              data.cost.cacheReadTokens + data.cost.cacheCreationTokens,
            ),
          ],
          [t("cost.resumeTax"), formatTokens(locale, data.cost.resumeTokens)],
        ].map(([label, value]) => (
          <div key={label} className="bg-ivory px-3 py-2">
            <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
              {label}
            </div>
            <div className="mt-1 font-mono text-[13px] font-semibold text-ink">
              {value}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 font-mono text-[10.5px] text-mute">
        <span className="rounded-full border border-line bg-ivory px-2 py-[2px]">
          {t("cost.projects", { count: data.cost.projectCount })}
        </span>
        <span className="rounded-full border border-line bg-ivory px-2 py-[2px]">
          {t("cost.flows", { count: data.cost.flowCount })}
        </span>
        <span className="rounded-full border border-line bg-ivory px-2 py-[2px]">
          {t("cost.nodes", { count: data.cost.nodeCount })}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <CostBreakdownCard
          keyHeader={labels.costBreakdown.modelHeader}
          labels={labels}
          locale={locale}
          rows={data.cost.byModel}
          testId="observatory-cost-by-model"
          title={labels.costBreakdown.byModelTitle}
        />
        <CostBreakdownCard
          keyHeader={labels.costBreakdown.runnerHeader}
          labels={labels}
          locale={locale}
          rows={data.cost.byRunner}
          testId="observatory-cost-by-runner"
          title={labels.costBreakdown.byRunnerTitle}
        />
        <CostBreakdownCard
          keyHeader={labels.costBreakdown.flowHeader}
          labels={labels}
          locale={locale}
          rows={data.cost.byFlow}
          testId="observatory-cost-by-flow"
          title={labels.costBreakdown.byFlowTitle}
        />
      </div>
      <div className="mt-4">
        <CostKindBreakdown
          labels={labels}
          locale={locale}
          rows={data.cost.byKind}
        />
      </div>
      <BudgetSurfaceCard budget={data.budget} labels={labels} locale={locale} />
    </section>
  );
}
