import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";
import pino from "pino";

import { PackageDetail } from "@/components/studio/package-detail";
import {
  getNamedPackageAttachmentIds,
  getStudioPackageBom,
} from "@/lib/queries/packages";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";
import { loadStudioPackagePage } from "@/components/studio/package-selection";
import { studioPackagePath } from "@/lib/studio/package-links";

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
    install?: string | string[];
    tab?: string | string[];
    page?: string | string[];
  }>;
};

export async function generateMetadata({
  params,
}: Pick<PageProps, "params">): Promise<Metadata> {
  const { ref } = await params;

  return { title: ref };
}

export default async function StudioPackageDetailPage({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { ref } = await params;
  const query = await searchParams;
  const { tab: rawTab, page: rawPage } = query;
  const selected = await loadStudioPackagePage(ref, [], query);

  if (selected.kind === "choice") return selected.chooser;

  const {
    user,
    resolution: { group, installId },
  } = selected;
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
        {ref}
      </h1>
    </header>
  );

  const projects = await getAccessibleProjects(user.id, user.role);
  const canManage = projects.some((project) => project.canManageCatalog);
  const canTrust = user.role === "admin";
  const manageableProjects = projects.filter(
    (project) => project.canManageCatalog,
  );
  const attached = await getNamedPackageAttachmentIds(
    group.name,
    manageableProjects.map((project) => project.id),
  );
  const attachTargets = manageableProjects.map((project) => ({
    slug: project.slug,
    name: project.name,
    attached: attached.get(project.id) === installId,
    occupied:
      attached.has(project.id) && attached.get(project.id) !== installId,
  }));
  const bom = (await getStudioPackageBom(installId)) ?? {
    flows: [],
    platformAgents: [],
    subagents: [],
    skills: [],
    mcps: [],
    rules: [],
  };
  const tab = firstParam(rawTab) ?? "flows";
  const pageRaw = Number.parseInt(firstParam(rawPage) ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  log.debug({ ref, tab, page }, "[studio.packageDetail]");

  return (
    <div className="w-full">
      {header}
      <PackageDetail
        activeTab={tab}
        attachInstallId={installId}
        attachTargets={attachTargets}
        basePath={studioPackagePath(group.name)}
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
