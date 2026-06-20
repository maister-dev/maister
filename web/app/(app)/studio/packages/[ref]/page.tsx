import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import pino from "pino";

import { PackageDetail } from "@/components/studio/package-detail";
import { requireSession } from "@/lib/authz";
import { getStudioPackageBom } from "@/lib/queries/packages";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";
import { loadStudioPackages } from "@/lib/studio/load";

const log = pino({
  name: "studio/packages/[ref]",
  level: process.env.LOG_LEVEL ?? "info",
});

function firstParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value && value.length > 0 ? value : null;
}

type PageProps = {
  params: Promise<{ ref: string }>;
  searchParams: Promise<{
    tab?: string | string[];
    page?: string | string[];
  }>;
};

export async function generateMetadata({
  params,
}: Pick<PageProps, "params">): Promise<Metadata> {
  const { ref } = await params;

  return { title: decodeURIComponent(ref) };
}

export default async function StudioPackageDetailPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { ref } = await params;
  const { tab: rawTab, page: rawPage } = await searchParams;
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
  const installId = group.versions[0]?.installId ?? "";
  const bom = (await getStudioPackageBom(installId)) ?? {
    flows: [],
    agents: [],
    skills: [],
    mcps: [],
    rules: [],
  };
  const tab = firstParam(rawTab) ?? "flows";
  const pageRaw = Number.parseInt(firstParam(rawPage) ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  log.debug({ ref: decoded, tab, page }, "[studio.packageDetail]");

  return (
    <div className="w-full">
      {header}
      <PackageDetail
        activeTab={tab}
        basePath={`/studio/packages/${encodeURIComponent(group.name)}`}
        canManage={canManage}
        canTrust={canTrust}
        page={page}
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
