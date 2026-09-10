"use client";

import type { RailSectionId } from "@/components/chrome/left-rail-route";
import type { ComponentType, ReactElement, SVGProps } from "react";

import {
  ChartBarIcon,
  ClockIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  InboxIcon,
  PuzzlePieceIcon,
  SignalIcon,
  Squares2X2Icon,
  TableCellsIcon,
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

/**
 * ADR-168 D7 / `ATN-05`: two badges, two tones, one source. The **attention**
 * tone means "N things are blocked on you"; the **neutral** tone means "N things
 * happened you have not seen". Nothing non-actionable may wear the attention
 * tone, which is why the tone travels with the value instead of being inferred
 * from the section id.
 *
 * `label` is the accessible name — a bare digit beside an icon tells a screen
 * reader nothing.
 */
export interface RailBadge {
  value: number;
  tone: "attention" | "neutral";
  label: string;
}

export type RailBadges = Partial<Record<RailSectionId, RailBadge>>;

export interface LeftRailNavProps {
  activeSection?: RailSectionId | null;
  ariaLabel: string;
  badges?: RailBadges;
  comingSoon: string;
  sections: readonly LeftRailNavSection[];
  variant: "collapsed" | "expanded";
}

const navIcon = "h-3.5 w-3.5 shrink-0 text-mute";
const navIconActive = "h-3.5 w-3.5 shrink-0 text-ink";

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

const sectionIcons: Record<RailSectionId, HeroIcon> = {
  projects: Squares2X2Icon,
  work: TableCellsIcon,
  inbox: InboxIcon,
  activity: SignalIcon,
  studio: WrenchScrewdriverIcon,
  observatory: ChartBarIcon,
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

const BADGE_TONE = {
  attention: "bg-amber text-white",
  neutral: "border border-line bg-ivory text-mute",
} as const satisfies Record<RailBadge["tone"], string>;

function CollapsedRailBadge({
  badge,
  sectionId,
}: {
  badge: RailBadge;
  sectionId: RailSectionId;
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 py-px text-center font-mono text-[9px] font-bold leading-none",
        BADGE_TONE[badge.tone],
      )}
      data-testid={`${sectionId}-nav-badge-collapsed`}
      title={badge.label}
    >
      {badge.value}
    </span>
  );
}

function LeftRailNavBody({
  activeSection,
  badges = {},
  comingSoon,
  sections,
  variant,
}: LeftRailNavProps): ReactElement {
  return (
    <>
      {sections.map((section) => {
        const isActive = section.id === activeSection;
        const badge = badges[section.id];
        const shownBadge = badge && badge.value > 0 ? badge : null;

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
              // The link's own `aria-label` REPLACES its contents, so a badge's
              // accessible name has to ride on it here rather than as an
              // `sr-only` child the way the expanded variant does.
              aria-label={
                shownBadge
                  ? `${section.label} · ${shownBadge.label}`
                  : section.label
              }
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
              {shownBadge ? (
                <CollapsedRailBadge badge={shownBadge} sectionId={section.id} />
              ) : null}
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
            {shownBadge ? (
              <span
                aria-hidden="true"
                className={clsx(
                  "ml-auto rounded-full px-1.5 py-px font-mono text-[9.5px] font-bold tracking-[0.02em]",
                  BADGE_TONE[shownBadge.tone],
                )}
                data-testid={`${section.id}-nav-badge`}
                title={shownBadge.label}
              >
                {shownBadge.value}
              </span>
            ) : null}
            {/* The badge itself is a bare digit; its meaning is announced here,
                so `textContent` on the badge stays a plain number. */}
            {shownBadge ? (
              <span className="sr-only">{shownBadge.label}</span>
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
      aria-label={props.ariaLabel}
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
  ariaLabel,
  badges,
  comingSoon,
  sections,
  variant,
}: LeftRailNavProps): ReactElement {
  const pathname = usePathname();
  const pathnameSection = railSectionForPathname(pathname);

  return (
    <LeftRailNavView
      activeSection={pathnameSection ?? activeSection}
      ariaLabel={ariaLabel}
      badges={badges}
      comingSoon={comingSoon}
      sections={sections}
      variant={variant}
    />
  );
}
