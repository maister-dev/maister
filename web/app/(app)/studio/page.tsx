import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { OverviewCards } from "@/components/studio/overview-cards";
import { requireSession } from "@/lib/authz";
import { loadStudioOverview } from "@/lib/studio/load";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("studio");

  return { title: t("title") };
}

export default async function StudioOverviewPage(): Promise<ReactElement> {
  const user = await requireSession();
  const t = await getTranslations("studio");
  const isAdmin = user.role === "admin";
  const overview = await loadStudioOverview(user.id, user.role);

  return (
    <div className="w-full">
      <header className="mb-7">
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("eyebrow")}
        </div>
        <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {t("title")}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
          {t("subtitle")}
        </p>
      </header>

      <OverviewCards
        groups={overview.groups}
        isAdmin={isAdmin}
        localSummary={overview.localSummary}
        recentLocalPackages={overview.recentLocalPackages}
        sourceSummary={overview.sourceSummary}
      />
    </div>
  );
}
