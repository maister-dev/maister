import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { LiveTicker } from "@/components/chrome/live-ticker";
import { DensityToggle } from "@/components/portfolio/density-toggle";
import { EmptyState } from "@/components/portfolio/empty-state";
import { NeedsYouSummary } from "@/components/portfolio/needs-you-summary";
import { NewProjectTile } from "@/components/portfolio/new-project-tile";
import { ProjectCard } from "@/components/portfolio/project-card";
import { ConfigPersistBanner } from "@/components/projects/config-persist-banner";
import { requireSession } from "@/lib/authz";
import { getUnreadInboxCount } from "@/lib/queries/inbox";
import {
  getCrossProjectHitlInbox,
  getPortfolio,
} from "@/lib/queries/portfolio";

export default async function PortfolioPage(): Promise<ReactElement> {
  const user = await requireSession();
  const t = await getTranslations("portfolio");

  const [portfolio, inbox, unreadInbox] = await Promise.all([
    getPortfolio(user.id, user.role),
    getCrossProjectHitlInbox(user.id, user.role),
    getUnreadInboxCount(user.id, user.role),
  ]);
  const needsYou = inbox.count + unreadInbox;
  const isEmpty = portfolio.projects.length === 0;

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
              needs: needsYou,
            })}
          </div>
        </div>
        {!isEmpty ? (
          <div className="flex items-center gap-2">
            <Link
              className="inline-flex items-center gap-2 rounded-full bg-amber px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_-10px_var(--amber)] transition-[transform,background] hover:-translate-y-px hover:bg-amber-2"
              href="/scratch-runs/new"
            >
              <span className="font-mono text-[16px] leading-none">+</span>
              {t("launchScratch")}
            </Link>
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
              needs: needsYou,
              b: (chunks) => (
                <b className="font-semibold text-ink-2">{chunks}</b>
              ),
            })}
          </LiveTicker>

          {needsYou > 0 ? (
            <NeedsYouSummary
              count={needsYou}
              href="/inbox"
              items={inbox.items.slice(0, 3)}
              labels={{
                title: t("inboxTitle", { count: needsYou }),
                seeAll: t("seeAll"),
              }}
            />
          ) : null}

          {user.role === "admin"
            ? portfolio.projects
                .filter((project) => project.needsPersist)
                .map((project) => (
                  <ConfigPersistBanner
                    key={project.id}
                    canEdit
                    needsPersist
                    projectName={project.name}
                    settingsHref={`/projects/${project.slug}?tab=settings`}
                    slug={project.slug}
                  />
                ))
            : null}

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
