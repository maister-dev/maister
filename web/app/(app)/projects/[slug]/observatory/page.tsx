import type { ObservatoryLabels } from "@/components/observatory/types";
import type { ObservatoryProject } from "@/lib/queries/observatory";
import type { ObservatorySearchParams } from "@/lib/observatory/filters";
import type { ReactElement } from "react";

import { getLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ProjectTabs } from "@/components/board/project-tabs";
import { AgentizationPanel } from "@/components/observatory/agentization-panel";
import { AutonomyFunnelCard } from "@/components/observatory/autonomy-funnel-card";
import { BudgetSurfaceCard } from "@/components/observatory/budget-surface-card";
import { ControlEffectivenessCard } from "@/components/observatory/control-effectiveness-card";
import { CostBreakdownCard } from "@/components/observatory/cost-breakdown-card";
import { CostKindBreakdown } from "@/components/observatory/cost-kind-breakdown";
import { CoverageMapCard } from "@/components/observatory/coverage-map-card";
import { labelsFromTranslations } from "@/components/observatory/labels";
import { NodeDrilldownTable } from "@/components/observatory/node-drilldown-table";
import { ObservatoryFilterBar } from "@/components/observatory/observatory-filter-bar";
import { ObservatorySummary } from "@/components/observatory/observatory-summary";
import { ObservatoryViews } from "@/components/observatory/observatory-views";
import { OverviewCostStrip } from "@/components/observatory/overview-cost-strip";
import { OverviewTable } from "@/components/observatory/overview-table";
import { QualityFlowsTable } from "@/components/observatory/quality-tables";
import { SensorFiringCard } from "@/components/observatory/sensor-firing-card";
import {
  FlowLedgerNotApplicable,
  FlowLedgerScope,
} from "@/components/observatory/flow-ledger-scope";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isProjectBrainIndexingAvailable } from "@/lib/brain/availability";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";
import { isFlowLedgerApplicable } from "@/lib/observatory/run-kind";
import { reposRoot } from "@/lib/instance-config";
import { formatProjectRepoPath } from "@/lib/project-path-display";
import {
  getNodeObservatoryDetail,
  getProjectObservatory,
} from "@/lib/queries/observatory";
import { getBoardData } from "@/lib/queries/board";
import { getProjectBySlug } from "@/lib/queries/project";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<ObservatorySearchParams>;
}

export default async function ProjectObservatoryPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { slug } = await params;
  const user = await getSessionUser();

  if (!user) notFound();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) notFound();

  const role =
    user.role === "admin" ? "owner" : await getProjectRole(user.id, project.id);

  if (role === null) notFound();

  const pathname = `/projects/${slug}/observatory`;
  const [t, tBucket, locale] = await Promise.all([
    getTranslations("observatory"),
    getTranslations("runBucket"),
    getLocale(),
  ]);
  const labels = labelsFromTranslations(t, tBucket);
  const displayRepoPath = formatProjectRepoPath(project.repoPath, reposRoot());
  const { filters, current } = parseObservatorySearchParams(await searchParams);
  const [observatory, board, brainIndexingAvailable] = await Promise.all([
    getProjectObservatory(project.id, filters),
    getBoardData(project.id),
    isProjectBrainIndexingAvailable(project),
  ]);
  const nodeDetail =
    current.view === "quality" &&
    current.nodeId &&
    isFlowLedgerApplicable(current.runKind)
      ? await getNodeObservatoryDetail(project.id, current.nodeId, filters)
      : null;

  return (
    <>
      <header className="mb-6 border-b border-line pb-5">
        <div className="mb-2 inline-flex items-center gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("projectEyebrow")}
        </div>
        <h1 className="m-0 text-[32px] font-semibold leading-[1.1] text-ink">
          {project.name} · {labels.projectTitle}
        </h1>
        <p className="mt-2 max-w-[60ch] text-sm leading-6 text-body">
          {displayRepoPath}
        </p>
      </header>

      <ProjectTabs
        active="observatory"
        boardCount={board.totalTasks}
        showBrain={brainIndexingAvailable}
        slug={slug}
      />
      <ObservatoryFilterBar
        current={current}
        labels={labels}
        pathname={pathname}
      />
      <ObservatoryViews current={current} labels={labels} pathname={pathname} />

      {current.view === "overview" ? (
        <>
          <OverviewTable
            current={current}
            labels={labels}
            liveLabel={
              observatory.overview.volatile
                ? t("overview.liveHint", { count: inFlightCount(observatory) })
                : null
            }
            projectSlug={slug}
            table={observatory.overview}
          />
          <OverviewCostStrip
            cost={observatory.cost}
            current={current}
            labels={labels}
            locale={locale}
            pathname={pathname}
          />
          <section className="mt-4">
            <AgentizationPanel
              data={observatory.agentization}
              labels={labels}
              locale={locale}
            />
            <div className="mt-4">
              <AutonomyFunnelCard
                data={observatory.funnel}
                labels={labels}
                locale={locale}
              />
            </div>
          </section>
        </>
      ) : null}

      {current.view === "cost" ? (
        <CostView data={observatory} labels={labels} locale={locale} t={t} />
      ) : null}

      {current.view === "quality" ? (
        isFlowLedgerApplicable(current.runKind) ? (
          <div className="grid grid-cols-1 items-start gap-4">
            <ObservatorySummary
              data={observatory}
              labels={labels}
              period={current.period}
              projectSlug={slug}
              runKind={current.runKind}
            />
            <QualityFlowsTable flows={observatory.flows} labels={labels} />
            {nodeDetail ? (
              <NodeDrilldownTable detail={nodeDetail} labels={labels} />
            ) : null}
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
                firing={observatory.harness.firing}
                labels={labels}
                neverFired={observatory.harness.neverFired}
                period={current.period}
                projectSlug={slug}
                runKind={current.runKind}
              />
              <ControlEffectivenessCard
                effectiveness={observatory.harness.effectiveness}
                labels={labels}
              />
              <CoverageMapCard
                coverage={observatory.harness.coverage}
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

function inFlightCount(data: ObservatoryProject): number {
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
  data: ObservatoryProject;
  labels: ObservatoryLabels;
  locale: string;
  t: Awaited<ReturnType<typeof getTranslations>>;
}): ReactElement {
  return (
    <section data-testid="observatory-cost">
      <header className="mb-3">
        <h2 className="m-0 text-lg font-semibold text-ink">
          {t("cost.title")}
        </h2>
        <p className="mt-1 max-w-[72ch] text-sm text-mute">
          {t("cost.subtitle")}
        </p>
        <p className="mt-1 max-w-[72ch] text-sm text-mute">
          {t("cost.periodScoped")}
        </p>
      </header>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
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
