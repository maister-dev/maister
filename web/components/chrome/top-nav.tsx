import type { ReactElement, ReactNode } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Logo } from "@/components/logo";
import { LangSwitch } from "@/components/chrome/lang-switch";
import { ThemeSwitch } from "@/components/chrome/theme-switch";
import { UserMenu, type NavUser } from "@/components/chrome/user-menu";

export interface TopNavProps {
  crumb?: ReactNode;
  user?: NavUser;
  logoSize?: number;
}

export async function TopNav({
  crumb,
  user,
  logoSize = 22,
}: TopNavProps): Promise<ReactElement> {
  const t = await getTranslations("nav");

  return (
    <div className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_oklab,var(--paper-warm)_82%,transparent)] backdrop-blur-[14px] backdrop-saturate-[140%]">
      <nav
        aria-label="Primary"
        className="flex w-full items-center justify-between gap-8 px-6 py-[14px]"
      >
        <div className="flex items-center gap-9">
          <Link className="cursor-pointer" href="/">
            <Logo size={logoSize} />
          </Link>
          <span className="ml-[18px] inline-flex items-center gap-1.5 border-l border-line pl-[18px] font-mono text-[11.5px] tracking-[0.04em] text-mute">
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
