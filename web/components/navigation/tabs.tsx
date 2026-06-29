import type { ReactElement, ReactNode } from "react";

import Link from "next/link";
import clsx from "clsx";

// Shared segmented-control tab bar (the canonical "style A" used across the
// project board, run workbench, Flow Studio package viewer, run inspector and
// the portfolio density toggle). Intentionally NOT a client component: it uses
// no hooks, so it adopts its importer's environment — rendering `<Link>` tabs in
// Server Components (href mode) and `<button>` tabs in Client Components
// (onSelect mode). See docs/screens/components.md for usage guidance.

export interface TabItem {
  key: string;
  label: ReactNode;
  // URL-driven nav: present → the tab renders as a <Link>. Absent → it renders
  // as a <button> that calls onSelect(key) (state-driven nav).
  href?: string;
  // Optional trailing count badge (e.g. board card count, package element count).
  count?: number;
  // Optional leading icon (e.g. the density toggle's grid/list glyphs).
  icon?: ReactNode;
  testId?: string;
}

export interface TabsProps {
  items: TabItem[];
  activeKey: string;
  // Required for href-less (button) items; ignored for <Link> items.
  onSelect?: (key: string) => void;
  // `inline` (default) = auto-width track; `fill` = full-width with equal columns.
  layout?: "inline" | "fill";
  ariaLabel?: string;
  className?: string;
}

const TRACK_BASE =
  "gap-0.5 rounded-full border border-line bg-ivory p-[3px] align-middle";

const TAB_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-[7px] font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.06em] transition-colors";

function tabClass(isActive: boolean, fill: boolean): string {
  return clsx(
    TAB_BASE,
    fill && "flex-1",
    isActive
      ? "bg-paper text-ink shadow-[var(--shadow-sm)]"
      : "text-mute hover:text-ink",
  );
}

function CountBadge({
  count,
  isActive,
}: {
  count: number;
  isActive: boolean;
}): ReactElement {
  return (
    <span
      className={clsx(
        "rounded-full border px-1.5 py-px font-mono text-[9.5px] font-bold leading-none",
        isActive
          ? "border-amber-line bg-amber-soft text-amber"
          : "border-line bg-paper text-mute",
      )}
    >
      {count}
    </span>
  );
}

export function Tabs({
  items,
  activeKey,
  onSelect,
  layout = "inline",
  ariaLabel,
  className,
}: TabsProps): ReactElement {
  const fill = layout === "fill";

  return (
    <div
      aria-label={ariaLabel}
      className={clsx(
        fill ? "flex w-full" : "inline-flex",
        TRACK_BASE,
        className,
      )}
      role="tablist"
    >
      {items.map((item) => {
        const isActive = item.key === activeKey;
        const inner = (
          <>
            {item.icon}
            {item.label}
            {item.count !== undefined ? (
              <CountBadge count={item.count} isActive={isActive} />
            ) : null}
          </>
        );

        if (item.href !== undefined) {
          return (
            <Link
              key={item.key}
              aria-selected={isActive}
              className={tabClass(isActive, fill)}
              data-testid={item.testId}
              href={item.href}
              role="tab"
            >
              {inner}
            </Link>
          );
        }

        return (
          <button
            key={item.key}
            aria-selected={isActive}
            className={tabClass(isActive, fill)}
            data-testid={item.testId}
            role="tab"
            type="button"
            onClick={onSelect ? () => onSelect(item.key) : undefined}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
