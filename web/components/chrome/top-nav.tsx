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
      {/* Every gutter and gap is narrow-first (`EDGE-NAV-02`). At 390px the
          header's own chrome — rail toggle, wordmark, the three account
          controls — is what made the PAGE scroll sideways, on every route in
          the app: `gap-8` + `px-6` alone spend 80px of a 390px viewport, and
          flex items default to `min-width: auto`, so nothing gave. The two
          groups are `min-w-0` so they CAN shrink, and everything inside them
          is `shrink-0` except the one thing that may truncate — the user's
          name. */}
      <nav
        aria-label={t("primaryLabel")}
        className="flex w-full items-center justify-between gap-2 px-3 py-[14px] md:gap-8 md:px-6"
      >
        <div className="flex min-w-0 items-center gap-3 md:gap-9">
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
          {/* The logo means HOME and keeps targeting `/` (ADR-172 D3). */}
          <Link className="shrink-0 cursor-pointer" href="/">
            <Logo size={logoSize} />
          </Link>
          {/* The explicit control for the two meanings `/` used to carry: Desk
              is `/`, Projects is `/projects` (ADR-172 D3). It is a switch, not
              a breadcrumb — the crumb below still says where you are. */}
          <HomeSwitch
            deskLabel={t("switchDesk")}
            label={t("switchLabel")}
            projectsLabel={t("switchProjects")}
          />
          {/* `min-w-0` + `truncate`: the crumb is the left group's only elastic
              member, so a long section label gives way here rather than pushing
              the account controls off the right edge. */}
          <span className="ml-[18px] hidden min-w-0 items-center gap-1.5 truncate border-l border-line pl-[18px] font-mono text-[11.5px] tracking-[0.04em] text-mute md:inline-flex">
            <span className="shrink-0">{t("crumbProjects")}</span>
            {crumb}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 md:gap-2.5">
          <LangSwitch />
          <ThemeSwitch />
          {user ? <UserMenu user={user} /> : null}
        </div>
      </nav>
    </div>
  );
}
