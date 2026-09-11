"use client";

import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";
import { usePathname } from "next/navigation";

import { railSectionForPathname } from "@/components/chrome/left-rail-route";

/**
 * The Desk | Projects switch (ADR-171 D3, `screens/chrome/top-nav.md`).
 *
 * `/` carried two meanings before this milestone — "home" and "the portfolio".
 * The switch is the visible answer to which one a reader wants, and it reuses
 * `railSectionForPathname` rather than re-deriving "am I on the portfolio":
 * a second classifier is how the rail and the header start disagreeing.
 */
export interface HomeSwitchProps {
  label: string;
  deskLabel: string;
  projectsLabel: string;
}

const BASE =
  "inline-flex h-[26px] items-center rounded-full px-2.5 text-[11.5px] font-semibold no-underline transition-colors";

export function HomeSwitch({
  label,
  deskLabel,
  projectsLabel,
}: HomeSwitchProps): ReactElement {
  const section = railSectionForPathname(usePathname());
  const options = [
    { href: "/", label: deskLabel, active: section === "home", id: "desk" },
    {
      href: "/projects",
      label: projectsLabel,
      active: section === "projects",
      id: "projects",
    },
  ];

  return (
    // Hidden below `md`, where the mobile rail drawer already carries Home and
    // Projects: keeping it would push the header past the viewport and make the
    // PAGE scroll sideways, which `EDGE-NAV-02` forbids.
    <nav
      aria-label={label}
      className="hidden items-center gap-0.5 rounded-full border border-line bg-ivory p-0.5 md:inline-flex"
      data-testid="home-switch"
    >
      {options.map((option) => (
        <Link
          key={option.id}
          aria-current={option.active ? "page" : undefined}
          className={clsx(
            BASE,
            option.active
              ? "bg-paper text-ink shadow-[var(--shadow-sm)]"
              : "text-mute hover:text-ink",
          )}
          data-testid={`home-switch-${option.id}`}
          href={option.href}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
