import type { NeedsYouItem } from "@/components/portfolio/needs-you-strip";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { LiveTicker } from "@/components/chrome/live-ticker";
import { DensityToggle } from "@/components/portfolio/density-toggle";
import { EmptyState } from "@/components/portfolio/empty-state";
import { NeedsYouStrip } from "@/components/portfolio/needs-you-strip";
import { NewProjectTile } from "@/components/portfolio/new-project-tile";
import { ProjectCard } from "@/components/portfolio/project-card";
import { requireSession } from "@/lib/authz";
import { getPortfolio } from "@/lib/queries/portfolio";

export default async function PortfolioPage(): Promise<ReactElement> {
  const user = await requireSession();
  const t = await getTranslations("portfolio");

  const portfolio = await getPortfolio(user.id, user.role);
  const isEmpty = portfolio.projects.length === 0;

  const needsItems: NeedsYouItem[] = portfolio.projects
    .filter((p) => p.need !== null && p.pendingHitlCount > 0)
    .map((p) => ({
      projectSlug: p.slug,
      agent: p.need!.agent,
      prompt: p.need!.prompt,
      branch: p.need!.branch,
      time: p.activeWorkspaces.find((ws) => ws.status === "needs")?.time ?? "—",
      runId: p.need!.runId,
    }));

  return (
    <>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
            {t("eyebrow", { projects: portfolio.projects.length })}
          </div>
          <h1 className="m-0 text-[32px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
            {t("heading")}
          </h1>
          <div className="mt-1.5 max-w-[56ch] text-[13.5px] leading-[1.5] text-mute">
            {t("subheading", {
              projects: portfolio.projects.length,
              workspaces: portfolio.totalActiveWorkspaces,
              needs: portfolio.totalNeeds,
            })}
          </div>
        </div>
        {!isEmpty ? (
          <div className="flex items-center gap-2">
            <DensityToggle
              comfyLabel={t("densityComfy")}
              compactLabel={t("densityCompact")}
              listLabel={t("densityList")}
            />
          </div>
        ) : null}
      </header>

      {isEmpty ? (
        <EmptyState />
      ) : (
        <>
          <LiveTicker>
            {t.rich("ticker", {
              projects: portfolio.projects.length,
              workspaces: portfolio.totalActiveWorkspaces,
              needs: portfolio.totalNeeds,
              b: (chunks) => (
                <b className="font-semibold text-ink-2">{chunks}</b>
              ),
            })}
          </LiveTicker>

          {needsItems.length > 0 ? (
            <NeedsYouStrip count={portfolio.totalNeeds} items={needsItems} />
          ) : null}

          <section
            aria-label="Projects"
            className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-[18px] [[data-density=compact]_&]:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] [[data-density=compact]_&]:gap-3 [[data-density=list]_&]:grid-cols-1 [[data-density=list]_&]:gap-2"
          >
            {portfolio.projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
            <NewProjectTile />
          </section>
        </>
      )}
    </>
  );
}
