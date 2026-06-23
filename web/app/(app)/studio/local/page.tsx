import type { LocalPackageListItem } from "@/components/studio/local-packages-list";
import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { LocalPackagesList } from "@/components/studio/local-packages-list";
import { requireSession } from "@/lib/authz";
import { listAllLocalPackages } from "@/lib/local-packages/service";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("studio");

  return { title: t("localTitle") };
}

export default async function StudioLocalPage(): Promise<ReactElement> {
  await requireSession();
  const t = await getTranslations("studio");
  const rows = await listAllLocalPackages();

  // Client-safe projection: `working_dir` + lock session stay server-side.
  const packages: LocalPackageListItem[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    isDefault: row.isDefault,
    status: row.status,
  }));

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
          {t("localTitle")}
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
          {t("localSub")}
        </p>
      </header>

      <LocalPackagesList packages={packages} />
    </div>
  );
}
