import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { PackageSourcesPanel } from "@/components/settings/package-sources-panel";
import { requireGlobalRole } from "@/lib/authz";
import { loadPackageSourcesView } from "@/lib/queries/packages";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("studio");

  return { title: t("sourcesTitle") };
}

export default async function StudioSourcesPage(): Promise<ReactElement> {
  await requireGlobalRole("admin");

  const t = await getTranslations("studio");
  const { sources, installs } = await loadPackageSourcesView();

  return (
    <div className="w-full">
      <header className="mb-7">
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("eyebrow")}
        </div>
        <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {t("sourcesTitle")}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
          {t("sourcesSub")}
        </p>
      </header>

      <div className="rounded-[16px] border border-line bg-paper p-7 shadow-[0_1px_0_color-mix(in_oklab,var(--paper)_60%,transparent)_inset,0_12px_32px_-16px_rgba(0,0,0,0.12)]">
        <PackageSourcesPanel installs={installs} sources={sources} />
      </div>
    </div>
  );
}
