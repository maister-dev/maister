import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ProjectTabs } from "@/components/board/project-tabs";
import { labelsFromTranslations } from "@/components/observatory/labels";
import { NodeDrilldownTable } from "@/components/observatory/node-drilldown-table";
import { ObservatoryFilters } from "@/components/observatory/observatory-filters";
import { ObservatorySummary } from "@/components/observatory/observatory-summary";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";
import {
  getNodeObservatoryDetail,
  getProjectObservatory,
} from "@/lib/queries/observatory";
import { getBoardData } from "@/lib/queries/board";
import { getProjectBySlug } from "@/lib/queries/project";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    flowId?: string | string[];
    nodeId?: string | string[];
    windowDays?: string | string[];
  }>;
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

  const t = await getTranslations("observatory");
  const labels = labelsFromTranslations(t);
  const { filters, current } = parseObservatorySearchParams(await searchParams);
  const [observatory, board] = await Promise.all([
    getProjectObservatory(project.id, filters),
    getBoardData(project.id),
  ]);
  const nodeDetail = current.nodeId
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
          {project.repoPath}
        </p>
      </header>

      <ProjectTabs
        active="observatory"
        boardCount={board.totalTasks}
        slug={slug}
      />
      <ObservatoryFilters current={current} labels={labels} />
      <ObservatorySummary
        data={observatory}
        labels={labels}
        projectSlug={slug}
      />
      {nodeDetail ? (
        <div className="mt-4">
          <NodeDrilldownTable detail={nodeDetail} labels={labels} />
        </div>
      ) : null}
    </>
  );
}
