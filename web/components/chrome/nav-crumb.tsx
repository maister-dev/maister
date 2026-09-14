"use client";

import type { ReactElement } from "react";

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
  fallback,
}: {
  labels: Record<string, string>;
  fallback: string;
}): ReactElement {
  const section = railSectionForPathname(usePathname());

  return (
    <>
      <span className="text-line">/</span>
      <b className="font-semibold text-ink" data-testid="nav-crumb">
        {(section && labels[section]) ?? fallback}
      </b>
    </>
  );
}
