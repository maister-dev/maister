"use client";

import type { RailSectionId } from "@/components/chrome/left-rail-route";
import type { ComponentType, ReactElement, SVGProps } from "react";

import {
  ClockIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  InboxIcon,
  PuzzlePieceIcon,
  Squares2X2Icon,
  UsersIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
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

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

const sectionIcons: Record<RailSectionId, HeroIcon> = {
  projects: Squares2X2Icon,
  inbox: InboxIcon,
  studio: WrenchScrewdriverIcon,
  agents: CpuChipIcon,
  mcps: PuzzlePieceIcon,
  users: UsersIcon,
  scheduler: ClockIcon,
  settings: Cog6ToothIcon,
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
  const Icon = sectionIcons[id];

  return (
    <Icon
      aria-hidden="true"
      className={className ?? (active ? navIconActive : navIcon)}
      data-testid={`rail-icon-${id}`}
    />
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
