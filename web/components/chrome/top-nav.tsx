import type { ReactElement, ReactNode } from "react";
import type {
  LeftRailNavSection,
  RailBadges,
} from "@/components/chrome/left-rail-nav";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { HomeSwitch } from "@/components/chrome/home-switch";
import { Logo } from "@/components/logo";
import { LangSwitch } from "@/components/chrome/lang-switch";
import { MobileRailDrawer } from "@/components/chrome/mobile-rail-drawer";
import { ThemeSwitch } from "@/components/chrome/theme-switch";
import { UserMenu, type NavUser } from "@/components/chrome/user-menu";

export interface TopNavProps {
  crumb?: ReactNode;
  user?: NavUser;
  logoSize?: number;
  badges?: RailBadges;
  sections?: readonly LeftRailNavSection[];
}

export async function TopNav({
  crumb,
  user,
  logoSize = 22,
  badges,
  sections = [],
}: TopNavProps): Promise<ReactElement> {
  const t = await getTranslations("nav");

  return (
    <div className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_oklab,var(--paper-warm)_82%,transparent)] backdrop-blur-[14px] backdrop-saturate-[140%]">
      <nav
        aria-label={t("primaryLabel")}
        className="flex w-full items-center justify-between gap-8 px-6 py-[14px]"
      >
        <div className="flex items-center gap-3 md:gap-9">
          {sections.length > 0 ? (
            <MobileRailDrawer
              ariaLabel={t("sectionsLabel")}
              badges={badges}
              closeLabel={t("closeNavigation")}
              comingSoon={t("comingSoon")}
              openLabel={t("openNavigation")}
              sections={sections}
            />
          ) : null}
          {/* The logo means HOME and keeps targeting `/` (ADR-171 D3). */}
          <Link className="cursor-pointer" href="/">
            <Logo size={logoSize} />
          </Link>
          {/* The explicit control for the two meanings `/` used to carry: Desk
              is `/`, Projects is `/projects` (ADR-171 D3). It is a switch, not
              a breadcrumb — the crumb below still says where you are. */}
          <HomeSwitch
            deskLabel={t("switchDesk")}
            label={t("switchLabel")}
            projectsLabel={t("switchProjects")}
          />
          <span className="hidden md:inline-flex ml-[18px] items-center gap-1.5 border-l border-line pl-[18px] font-mono text-[11.5px] tracking-[0.04em] text-mute">
            <span>{t("crumbProjects")}</span>
            {crumb}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <LangSwitch />
          <ThemeSwitch />
          {user ? <UserMenu user={user} /> : null}
        </div>
      </nav>
    </div>
  );
}
