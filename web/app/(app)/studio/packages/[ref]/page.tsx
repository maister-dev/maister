import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Link from "next/link";

import { PackageDetail } from "@/components/studio/package-detail";
import { requireSession } from "@/lib/authz";
import { getStudioPackageBom } from "@/lib/queries/packages";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";
import { loadStudioPackages } from "@/lib/studio/load";

type PageProps = { params: Promise<{ ref: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { ref } = await params;

  return { title: decodeURIComponent(ref) };
}

export default async function StudioPackageDetailPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { ref } = await params;
  const decoded = decodeURIComponent(ref);
  const user = await requireSession();
  const groups = await loadStudioPackages(user.id, user.role);
  const matches = groups.filter((group) => group.name === decoded);

  if (matches.length === 0) notFound();

  const t = await getTranslations("studio");
  const header = (
    <header className="mb-7">
      <Link
        className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
        href="/studio/packages"
      >
        {t("backToPackages")}
      </Link>
      <h1 className="m-0 text-[28px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
        {decoded}
      </h1>
    </header>
  );

  // `ref` is the package name only (Phase A); two sources can expose the same
  // name. A durable base64url(source::name) ref is deferred — for now surface the
  // collision instead of silently picking one.
  if (matches.length > 1) {
    return (
      <div className="w-full">
        {header}
        <p className="mb-1 text-[14px] font-semibold text-ink">
          {t("ambiguousTitle")}
        </p>
        <p className="mb-3 text-[13px] text-mute">{t("ambiguousHint")}</p>
        <ul className="flex list-none flex-col gap-1.5">
          {matches.map((group) => (
            <li
              key={group.key}
              className="rounded-[12px] border border-line bg-paper px-4 py-3 font-mono text-[12px] text-ink-2"
            >
              {group.sourceUrl}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const group = matches[0];
  const projects = await getAccessibleProjects(user.id, user.role);
  const canManage = projects.some((project) => project.canManageCatalog);
  const canTrust = user.role === "admin";
  const bom = (await getStudioPackageBom(
    group.versions[0]?.installId ?? "",
  )) ?? { flows: [], agents: [], skills: [], mcps: [], rules: [] };

  return (
    <div className="w-full">
      {header}
      <PackageDetail
        canManage={canManage}
        canTrust={canTrust}
        pkg={{
          name: group.name,
          sourceUrl: group.sourceUrl,
          isLocal: group.isLocal,
          versions: group.versions,
          bom,
        }}
      />
    </div>
  );
}
