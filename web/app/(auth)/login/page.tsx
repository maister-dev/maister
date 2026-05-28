import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { AuthCard } from "@/components/auth/auth-card";
import { SidePanel } from "@/components/auth/side-panel";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");

  return { title: t("titleLogin") };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}): Promise<ReactElement> {
  const { callbackUrl } = await searchParams;
  const redirectTo = callbackUrl ?? "/";

  return (
    <>
      <div className="relative z-[2] flex flex-1 basis-1/2 items-center justify-center bg-paper-warm px-10 pb-20 pt-12">
        <AuthCard redirectTo={redirectTo} />
      </div>
      <aside
        aria-hidden="true"
        className="relative hidden flex-1 basis-1/2 items-center justify-center overflow-hidden border-r border-line px-10 pb-20 pt-12 [background:linear-gradient(135deg,color-mix(in_oklab,var(--amber)_6%,var(--paper-warm))_0%,var(--paper-warm)_60%,color-mix(in_oklab,var(--accent-3)_8%,var(--paper-warm))_100%)] lg:flex"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.55] [background-image:radial-gradient(var(--line)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_at_50%_50%,#000_0%,transparent_80%)]"
        />
        <SidePanel />
      </aside>
    </>
  );
}
