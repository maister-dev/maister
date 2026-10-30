"use client";

import type { ReactElement } from "react";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { railSectionForPathname } from "@/components/chrome/left-rail-route";

/**
 * The header crumb. It named "portfolio" unconditionally until ADR-172 split
 * `/` from `/projects`; on the Desk that was simply false, so it now reads the
 * same classifier the rail and the Desk | Projects switch read.
 *
 * Labels arrive pre-translated: `railSectionForPathname` lives in a client
 * module, but `getTranslations` does not.
 */
export function NavCrumb({
  labels,
  hrefs,
  fallback,
  ariaLabel,
}: {
  labels: Record<string, string>;
  hrefs: Record<string, string>;
  fallback: string;
  ariaLabel: string;
}): ReactElement {
  const pathname = usePathname();
  const section = railSectionForPathname(pathname);
  const label = (section && labels[section]) ?? fallback;
  const href = (section && hrefs[section]) ?? "/";

  return (
    <nav aria-label={ariaLabel} data-testid="nav-crumb">
      <Link
        aria-current={pathname === href ? "page" : undefined}
        className="inline-flex max-w-full items-center font-semibold text-ink underline decoration-transparent underline-offset-4 transition-colors hover:text-amber hover:decoration-amber focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40"
        href={href}
      >
        <span className="truncate">{label}</span>
      </Link>
    </nav>
  );
}
