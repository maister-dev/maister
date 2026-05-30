import type { GlobalRole } from "@/lib/db/schema";
import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { signOutUser } from "@/app/(app)/account/actions";

export interface NavUser {
  email: string;
  initials: string;
  name: string;
  role: GlobalRole;
}

export interface UserMenuProps {
  user: NavUser;
}

export async function UserMenu({ user }: UserMenuProps): Promise<ReactElement> {
  const t = await getTranslations("accountMenu");

  return (
    <details className="group relative">
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-paper py-1.5 pl-1.5 pr-3 font-mono text-[11px] tracking-[0.04em] text-ink-2 transition-colors hover:border-mute group-open:border-amber-line group-open:bg-amber-soft [&::-webkit-details-marker]:hidden">
        <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border border-amber-line bg-amber-soft text-[10.5px] font-bold text-amber">
          {user.initials}
        </span>
        <span className="max-w-[180px] truncate">{user.name}</span>
        <span
          aria-hidden="true"
          className="text-mute transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>

      <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-[260px] overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]">
        <div className="border-b border-line bg-[color-mix(in_oklab,var(--ivory)_45%,var(--paper))] px-4 py-3">
          <div className="truncate text-[13px] font-semibold text-ink">
            {user.name}
          </div>
          <div className="mt-1 truncate font-mono text-[10.5px] tracking-[0.03em] text-mute">
            {user.email}
          </div>
          <div className="mt-2 w-max rounded-full border border-amber-line bg-amber-soft px-2 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-amber">
            {t(`role.${user.role}`)}
          </div>
        </div>

        <nav aria-label={t("label")} className="flex flex-col p-1.5">
          <MenuLink href="/account">{t("settings")}</MenuLink>
          <MenuLink href="/account/password">{t("password")}</MenuLink>
          {user.role === "admin" ? (
            <MenuLink href="/admin/users">{t("adminUsers")}</MenuLink>
          ) : null}
        </nav>

        <form action={signOutUser} className="border-t border-line p-1.5">
          <button
            className="flex w-full cursor-pointer items-center rounded-[10px] px-3 py-2.5 text-left font-mono text-[11px] font-semibold tracking-[0.03em] text-mute transition-colors hover:bg-ivory hover:text-ink"
            type="submit"
          >
            {t("signOut")}
          </button>
        </form>
      </div>
    </details>
  );
}

function MenuLink({
  children,
  href,
}: {
  children: string;
  href: string;
}): ReactElement {
  return (
    <Link
      className="rounded-[10px] px-3 py-2.5 font-mono text-[11px] font-semibold tracking-[0.03em] text-ink-2 transition-colors hover:bg-ivory hover:text-ink"
      href={href}
    >
      {children}
    </Link>
  );
}
