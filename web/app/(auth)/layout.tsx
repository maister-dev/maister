import type { ReactElement, ReactNode } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { LangSwitch } from "@/components/chrome/lang-switch";
import { StatusBar } from "@/components/chrome/status-bar";
import { ThemeSwitch } from "@/components/chrome/theme-switch";
import { Logo } from "@/components/logo";
import { getPlatformStatus } from "@/lib/supervisor-client";

export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  const [t, platformStatus] = await Promise.all([
    getTranslations("status"),
    getPlatformStatus(),
  ]);

  return (
    <div className="flex min-h-screen flex-col bg-paper-warm">
      <div className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_oklab,var(--paper-warm)_82%,transparent)] backdrop-blur-[14px] backdrop-saturate-[140%]">
        <nav
          aria-label="Primary"
          className="flex w-full items-center justify-between gap-8 px-8 py-5"
        >
          <Link className="cursor-pointer" href="/">
            <Logo />
          </Link>
          <div className="flex items-center gap-2.5">
            <LangSwitch />
            <ThemeSwitch />
          </div>
        </nav>
      </div>

      <main
        className="relative flex flex-1 flex-row-reverse items-stretch overflow-hidden"
        data-layout="split-spine"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 opacity-50 [background-image:radial-gradient(var(--line)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(ellipse_at_50%_40%,#000_0%,transparent_70%)]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0 opacity-[0.85] [background:radial-gradient(circle_at_52%_40%,color-mix(in_oklab,var(--amber)_14%,transparent)_0%,transparent_50%)]"
        />
        {children}
      </main>

      <StatusBar platformStatus={platformStatus} summary={t("poc")} />
    </div>
  );
}
