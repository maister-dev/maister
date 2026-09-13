import type { GlobalRole } from "@/lib/db/schema";
import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AutoCloseDetails } from "@/components/chrome/auto-close-details";
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
    <AutoCloseDetails className="group relative">
      {/* The name is the ONE elastic thing in the header, by design: everything
          else here is `shrink-0`, so when a narrow viewport runs out of room
          this truncates instead of the page scrolling sideways
          (`EDGE-NAV-02`). It stays in the DOM at every width — hiding it would
          strip the user's name out of the control's accessible name, and the
          visible text stays a prefix of that name rather than a different
          string. */}
      <summary className="inline-flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-paper py-1.5 pl-1.5 pr-2.5 font-mono text-[11px] tracking-[0.04em] text-ink-2 transition-colors hover:border-mute group-open:border-amber-line group-open:bg-amber-soft md:pr-3 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-amber-line bg-amber-soft text-[10.5px] font-bold text-amber">
          {user.initials}
        </span>
        <span className="max-w-[48px] truncate md:max-w-[180px]">
          {user.name}
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-mute transition-transform group-open:rotate-180"
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
    </AutoCloseDetails>
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
