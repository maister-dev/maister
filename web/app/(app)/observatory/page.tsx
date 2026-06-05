import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { labelsFromTranslations } from "@/components/observatory/labels";
import { ObservatoryFilters } from "@/components/observatory/observatory-filters";
import { ObservatorySummary } from "@/components/observatory/observatory-summary";
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
    </>
  );
}
