import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ProfileForm } from "@/components/account/profile-form";
import { requireActiveSession } from "@/lib/authz";

export default async function AccountPage(): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("account");

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
          {t("eyebrow")}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
              {t("title")}
            </h1>
            <p className="mt-2 max-w-[560px] text-[13.5px] leading-[1.55] text-mute">
              {t("sub")}
            </p>
          </div>
          <Link
            className="inline-flex w-max items-center rounded-full border border-line bg-paper px-4 py-2.5 font-mono text-[11px] font-semibold tracking-[0.04em] text-ink-2 transition-colors hover:border-mute hover:text-ink"
            href="/account/password"
          >
            {t("passwordLink")}
          </Link>
        </div>
      </header>

      <section className="rounded-[14px] border border-line bg-paper p-6 shadow-[var(--shadow-sm)]">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
              {t("profileTitle")}
            </h2>
            <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">
              {t("profileSub")}
            </p>
          </div>
          <span className="rounded-full border border-amber-line bg-amber-soft px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-amber">
            {t(`role.${user.role}`)}
          </span>
        </div>
        <ProfileForm
          email={user.email ?? ""}
          name={user.name ?? user.email ?? ""}
        />
      </section>
    </div>
  );
}
