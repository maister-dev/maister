import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { Tabs, type TabItem } from "@/components/navigation/tabs";

export type ProjectTab =
  | "board"
  | "activity"
  | "observatory"
  | "prs"
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

  const hrefFor = (tab: ProjectTab): string =>
    tab === "board"
      ? `/projects/${slug}`
      : tab === "observatory"
        ? `/projects/${slug}/observatory`
        : `/projects/${slug}?tab=${tab}`;

  const items: TabItem[] = TABS.map((tab) => ({
    key: tab,
    label: label[tab],
    href: hrefFor(tab),
    count: tab === "board" ? boardCount : undefined,
  }));

  return <Tabs activeKey={active} className="mb-[22px]" items={items} />;
}
