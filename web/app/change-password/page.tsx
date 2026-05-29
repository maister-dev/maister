import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { LangSwitch } from "@/components/chrome/lang-switch";
import { ThemeSwitch } from "@/components/chrome/theme-switch";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { Logo } from "@/components/logo";
import { getSessionUser } from "@/lib/authz";

export default async function ChangePasswordPage(): Promise<ReactElement> {
  const user = await getSessionUser();

  if (!user) redirect("/login");
  if (!user.mustChangePassword) redirect("/");

  const t = await getTranslations("changePassword");

  return (
    <div className="flex min-h-screen flex-col bg-paper-warm">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <Logo />
        <div className="flex items-center gap-2.5">
          <LangSwitch />
          <ThemeSwitch />
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] rounded-2xl border border-line bg-paper p-9 shadow-[var(--shadow-lg)]">
          <h1 className="mb-1.5 text-[22px] font-semibold tracking-[-0.02em] text-ink">
            {t("title")}
          </h1>
          <p className="mb-6 text-[13.5px] leading-[1.55] text-mute">
            {t("sub")}
          </p>
          <ChangePasswordForm />
        </div>
      </main>
    </div>
  );
}
