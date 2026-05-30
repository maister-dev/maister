import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AccountPasswordForm } from "@/components/account/password-form";
import { requireActiveSession } from "@/lib/authz";

export default async function AccountPasswordPage(): Promise<ReactElement> {
  await requireActiveSession();
  const t = await getTranslations("account");

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          className="w-max font-mono text-[11px] font-semibold tracking-[0.04em] text-mute transition-colors hover:text-ink"
          href="/account"
        >
          {t("backToAccount")}
        </Link>
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
          {t("securityEyebrow")}
        </div>
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
          {t("passwordTitle")}
        </h1>
        <p className="max-w-[520px] text-[13.5px] leading-[1.55] text-mute">
          {t("passwordSub")}
        </p>
      </header>

      <section className="rounded-[14px] border border-line bg-paper p-6 shadow-[var(--shadow-sm)]">
        <AccountPasswordForm />
      </section>
    </div>
  );
}
