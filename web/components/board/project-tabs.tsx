import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

export type ProjectTab =
  | "board"
  | "activity"
  | "observatory"
  | "prs"
  | "flows"
  | "repo"
  | "packages"
  | "integrations"
  | "mcps"
  | "schedules"
  | "agents"
  | "members"
  | "webhooks"
  | "settings";

export interface ProjectTabsProps {
  slug: string;
  active: ProjectTab;
  boardCount: number;
}

const TABS: readonly ProjectTab[] = [
  "board",
  "activity",
  "observatory",
  "prs",
  "flows",
  "repo",
  "packages",
  "integrations",
  "mcps",
  "schedules",
  "agents",
  "members",
  "webhooks",
  "settings",
];

export async function ProjectTabs({
  slug,
  active,
  boardCount,
}: ProjectTabsProps): Promise<ReactElement> {
  const t = await getTranslations("nav");

  const label: Record<ProjectTab, string> = {
    board: t("board"),
    activity: t("activity"),
    observatory: t("observatory"),
    prs: t("prs"),
    flows: t("flows"),
    repo: t("repo"),
    packages: t("packages"),
    integrations: t("integrations"),
    mcps: t("mcps"),
    schedules: t("schedules"),
    agents: t("agents"),
    members: t("members"),
    webhooks: t("webhooks"),
    settings: t("settings"),
  };

  return (
    <div
      className="mb-[22px] inline-flex gap-0.5 rounded-full border border-line bg-ivory p-[3px]"
      role="tablist"
    >
      {TABS.map((tab) => {
        const isActive = tab === active;

        return (
          <Link
            key={tab}
            aria-selected={isActive}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full px-3.5 py-[7px] font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.06em]",
              isActive
                ? "bg-paper text-ink shadow-[var(--shadow-sm)]"
                : "text-mute hover:text-ink",
            )}
            href={
              tab === "board"
                ? `/projects/${slug}`
                : tab === "observatory"
                  ? `/projects/${slug}/observatory`
                  : `/projects/${slug}?tab=${tab}`
            }
            role="tab"
          >
            {label[tab]}
            {tab === "board" ? (
              <span
                className={clsx(
                  "rounded-full border px-1.5 py-px font-mono text-[9.5px] font-bold",
                  isActive
                    ? "border-amber-line bg-amber-soft text-amber"
                    : "border-line bg-paper text-mute",
                )}
              >
                {boardCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
