"use client";

import type { RailSectionId } from "@/components/chrome/left-rail-route";
import type { ReactElement, ReactNode } from "react";

import { usePathname } from "next/navigation";
import Link from "next/link";
import clsx from "clsx";

import { railSectionForPathname } from "@/components/chrome/left-rail-route";

export interface LeftRailNavSection {
  id: RailSectionId;
  label: string;
  href: string;
  ready: boolean;
}

export interface LeftRailNavProps {
  activeSection?: RailSectionId | null;
  comingSoon: string;
  inboxCount: number;
  sections: readonly LeftRailNavSection[];
  variant: "collapsed" | "expanded";
}

const navIcon = "h-3.5 w-3.5 shrink-0 text-mute";
const navIconActive = "h-3.5 w-3.5 shrink-0 text-ink";

const sectionIcons: Record<RailSectionId, ReactNode> = {
  projects: (
    <>
      <rect height="5" rx="1" width="5" x="2" y="2" />
      <rect height="5" rx="1" width="5" x="9" y="2" />
      <rect height="5" rx="1" width="5" x="2" y="9" />
      <rect height="5" rx="1" width="5" x="9" y="9" />
    </>
  ),
  inbox: <path d="M2 4h12M2 8h12M2 12h7" />,
  studio: <path d="M3 3 L13 3 L9 8 L13 13 L3 13 L7 8 Z" />,
  agents: (
    <>
      <circle cx="8" cy="5" r="2.6" />
      <path d="M2.4 14c0-3 2.5-5.4 5.6-5.4S13.6 11 13.6 14" />
    </>
  ),
  mcps: (
    <>
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="12" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M4 5.6V10.4M12 5.6V10.4M5.6 4H10.4M5.6 12H10.4" />
    </>
  ),
  users: (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <path d="M1.5 13.4c0-2.4 2-4.2 4.5-4.2s4.5 1.8 4.5 4.2" />
      <path d="M10.8 5.3a2.2 2.2 0 0 1 0 4.1M14.5 13.4c0-1.8-1-3.2-2.6-3.8" />
    </>
  ),
  scheduler: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.4 1.5" />
    </>
  ),
  settings: (
    <>
      <path d="M6.9 1.7h2.2l.36 1.55c.38.13.74.32 1.07.57l1.5-.48 1.1 1.9-1.15 1.05c.04.23.06.47.06.71s-.02.48-.06.71l1.15 1.05-1.1 1.9-1.5-.48c-.33.25-.69.44-1.07.57L9.1 14.3H6.9l-.36-1.55a4.5 4.5 0 0 1-1.07-.57l-1.5.48-1.1-1.9 1.15-1.05A4.08 4.08 0 0 1 3.96 8c0-.24.02-.48.06-.71L2.87 6.24l1.1-1.9 1.5.48c.33-.25.69-.44 1.07-.57L6.9 1.7z" />
      <circle cx="8" cy="8" r="2.05" />
    </>
  ),
};

function RailSectionIcon({
  active = false,
  className,
  id,
}: {
  active?: boolean;
  className?: string;
  id: RailSectionId;
}): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className={className ?? (active ? navIconActive : navIcon)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 16 16"
    >
      {sectionIcons[id]}
    </svg>
  );
}

function CollapsedRailBadge({ value }: { value: number }): ReactElement {
  return (
    <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-amber px-1 py-px text-center font-mono text-[9px] font-bold leading-none text-white">
      {value}
    </span>
  );
}

function LeftRailNavBody({
  activeSection,
  comingSoon,
  inboxCount,
  sections,
  variant,
}: LeftRailNavProps): ReactElement {
  return (
    <>
      {sections.map((section) => {
        const isActive = section.id === activeSection;
        const showBadge = section.id === "inbox" && inboxCount > 0;

        if (!section.ready) {
          return variant === "collapsed" ? (
            <span
              key={section.id}
              aria-disabled="true"
              aria-label={section.label}
              className="relative inline-flex h-9 w-9 cursor-default items-center justify-center rounded-[10px] text-mute opacity-60"
              title={`${section.label} · ${comingSoon}`}
            >
              <RailSectionIcon id={section.id} />
              <span className="sr-only">{section.label}</span>
            </span>
          ) : (
            <span
              key={section.id}
              aria-disabled="true"
              className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] text-mute opacity-60"
              title={comingSoon}
            >
              <RailSectionIcon id={section.id} />
              <span>{section.label}</span>
            </span>
          );
        }

        if (variant === "collapsed") {
          return (
            <Link
              key={section.id}
              aria-current={isActive ? "page" : undefined}
              aria-label={section.label}
              className={clsx(
                "relative inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-[10px] transition-colors",
                "hover:bg-ivory hover:text-ink",
                isActive ? "bg-ivory text-ink" : "text-ink-2",
              )}
              data-testid={`rail-nav-${section.id}`}
              href={section.href}
              title={section.label}
            >
              <RailSectionIcon active={isActive} id={section.id} />
              <span className="sr-only">{section.label}</span>
              {showBadge ? <CollapsedRailBadge value={inboxCount} /> : null}
            </Link>
          );
        }

        return (
          <Link
            key={section.id}
            aria-current={isActive ? "page" : undefined}
            className={clsx(
              "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px]",
              "hover:bg-ivory hover:text-ink",
              isActive ? "bg-ivory font-semibold text-ink" : "text-ink-2",
            )}
            data-testid={`rail-nav-${section.id}`}
            href={section.href}
          >
            <RailSectionIcon active={isActive} id={section.id} />
            <span>{section.label}</span>
            {showBadge ? (
              <span
                className="ml-auto rounded-full bg-amber px-1.5 py-px font-mono text-[9.5px] font-bold tracking-[0.02em] text-white"
                data-testid="inbox-nav-badge"
              >
                {inboxCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </>
  );
}

export function LeftRailNavView(props: LeftRailNavProps): ReactElement {
  return (
    <nav
      aria-label="Sections"
      className={
        props.variant === "collapsed"
          ? "flex shrink-0 flex-col items-center gap-1 border-b border-line pb-2"
          : "flex shrink-0 flex-col gap-px border-b border-line pb-3 pt-1.5"
      }
    >
      <LeftRailNavBody {...props} />
    </nav>
  );
}

export function LeftRailNav({
  activeSection = null,
  comingSoon,
  inboxCount,
  sections,
  variant,
}: LeftRailNavProps): ReactElement {
  const pathname = usePathname();
  const pathnameSection = railSectionForPathname(pathname);

  return (
    <LeftRailNavView
      activeSection={pathnameSection ?? activeSection}
      comingSoon={comingSoon}
      inboxCount={inboxCount}
      sections={sections}
      variant={variant}
    />
  );
}
