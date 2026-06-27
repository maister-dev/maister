import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PackagesList } from "@/components/studio/packages-list";
import { requireSession } from "@/lib/authz";
import { loadStudioPackages } from "@/lib/studio/load";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("studio");

  return { title: t("packagesTitle") };
}

export default async function StudioPackagesPage(): Promise<ReactElement> {
  const user = await requireSession();
  const t = await getTranslations("studio");
  const groups = await loadStudioPackages(user.id, user.role);

  return (
    <div className="w-full">
      <header className="mb-7">
        <Link
          className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
          href="/studio"
        >
          {t("backToStudio")}
        </Link>
        <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {t("packagesTitle")}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
          {t("packagesSub")}
        </p>
      </header>

      <PackagesList groups={groups} />
    </div>
  );
}
