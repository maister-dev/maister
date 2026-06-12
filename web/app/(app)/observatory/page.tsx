import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { ControlEffectivenessCard } from "@/components/observatory/control-effectiveness-card";
import { CoverageMapCard } from "@/components/observatory/coverage-map-card";
import { labelsFromTranslations } from "@/components/observatory/labels";
import { ObservatoryFilters } from "@/components/observatory/observatory-filters";
import { ObservatorySummary } from "@/components/observatory/observatory-summary";
import { SensorFiringCard } from "@/components/observatory/sensor-firing-card";
import { requireSession } from "@/lib/authz";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";
import { getPortfolioObservatory } from "@/lib/queries/observatory";

interface PageProps {
  searchParams: Promise<{
    artifactDefId?: string | string[];
    artifactKind?: string | string[];
    flowId?: string | string[];
    nodeId?: string | string[];
    windowDays?: string | string[];
  }>;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export default async function ObservatoryPage({
  searchParams,
}: PageProps): Promise<ReactElement> {
  const user = await requireSession();
  const t = await getTranslations("observatory");
  const { filters, current } = parseObservatorySearchParams(await searchParams);
  const data = await getPortfolioObservatory(user.id, user.role, filters);
  const labels = labelsFromTranslations(t);

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

      <ObservatoryFilters current={current} labels={labels} />
      <ObservatorySummary data={data} labels={labels} />
      <section
        className="mt-6 rounded-[14px] border border-line bg-paper p-5"
        data-testid="observatory-cost"
      >
        <div
          aria-label={t("cost.tabsLabel")}
          className="mb-4 flex border-b border-line"
          role="tablist"
        >
          <button
            aria-selected="true"
            className="border-b-2 border-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-amber"
            role="tab"
            type="button"
          >
            {t("cost.tab")}
          </button>
        </div>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="m-0 text-lg font-semibold text-ink">
              {t("cost.title")}
            </h2>
            <p className="mt-1 max-w-[72ch] text-sm text-mute">
              {t("cost.subtitle")}
            </p>
          </div>
          <span className="rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute">
            {t("cost.readOnly")}
          </span>
        </div>
        <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
          {[
            [t("cost.inputTokens"), formatTokens(data.cost.inputTokens)],
            [t("cost.outputTokens"), formatTokens(data.cost.outputTokens)],
            [
              t("cost.cacheTokens"),
              formatTokens(
                data.cost.cacheReadTokens + data.cost.cacheCreationTokens,
              ),
            ],
            [t("cost.resumeTax"), formatTokens(data.cost.resumeTokens)],
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
      </section>
      <section className="mt-6">
        <header className="mb-3">
          <h2 className="m-0 text-lg font-semibold text-ink">
            {labels.harness.sectionTitle}
          </h2>
          <p className="mt-1 max-w-[72ch] text-sm text-mute">
            {labels.harness.sectionSubtitle}
          </p>
        </header>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <SensorFiringCard
            firing={data.harness.firing}
            labels={labels}
            neverFired={data.harness.neverFired}
          />
          <ControlEffectivenessCard
            effectiveness={data.harness.effectiveness}
            labels={labels}
          />
          <CoverageMapCard coverage={data.harness.coverage} labels={labels} />
        </div>
      </section>
    </>
  );
}
