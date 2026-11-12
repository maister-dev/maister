"use client";

import type { ReactElement, ReactNode } from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import clsx from "clsx";

import { useIsClient } from "@/lib/use-is-client";

const STORAGE_KEY = "maister:rail-collapsed";

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    /* localStorage unavailable (private mode) — stay expanded */
    return false;
  }
}

export function RailCollapseView({
  collapsed,
  onToggle,
  ariaLabel,
  collapseLabel,
  expandLabel,
  collapsedChildren,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  ariaLabel: string;
  collapseLabel: string;
  expandLabel: string;
  collapsedChildren?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  const ToggleIcon = collapsed ? ChevronRightIcon : ChevronLeftIcon;

  return (
    <aside
      aria-label={ariaLabel}
      className={clsx(
        "sticky top-[64px] z-10 hidden h-[calc(100vh-64px-36px)] flex-col self-start border-r border-line bg-paper pb-0 pt-2.5 md:flex",
        collapsed ? "overflow-visible" : "overflow-x-hidden",
        collapsed ? "w-12 px-1.5" : "w-[260px] px-3.5",
      )}
      data-collapsed={collapsed ? "true" : "false"}
      data-testid="left-rail"
    >
      <div
        className={clsx(
          "flex shrink-0",
          collapsed ? "justify-center" : "justify-end",
        )}
      >
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? expandLabel : collapseLabel}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-line text-mute hover:bg-ivory hover:text-ink"
          data-testid="rail-collapse-toggle"
          title={collapsed ? expandLabel : collapseLabel}
          type="button"
          onClick={onToggle}
        >
          <ToggleIcon
            aria-hidden="true"
            className="h-3.5 w-3.5"
            data-testid="rail-collapse-icon"
          />
        </button>
      </div>
      {collapsed ? (
        <div
          className="mt-2.5 flex min-h-0 flex-1 flex-col items-center gap-2"
          data-testid="rail-collapsed-content"
        >
          {collapsedChildren}
        </div>
      ) : (
        <div
          className="mt-2.5 flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto"
          data-testid="rail-content"
        >
          {children}
        </div>
      )}
    </aside>
  );
}

// Stateful client wrapper: owns the collapsed flag, restores/persists it to
// localStorage (default expanded; a brief expanded flash on a collapsed reload is
// accepted — no inline script, matching the script-free theme convention).
export function RailCollapse({
  ariaLabel,
  collapseLabel,
  collapsedChildren,
  expandLabel,
  children,
}: {
  ariaLabel: string;
  collapseLabel: string;
  collapsedChildren?: ReactNode;
  expandLabel: string;
  children: ReactNode;
}): ReactElement {
  const isClient = useIsClient();
  // The stored preference is read once the client takes over; a toggle in this
  // session overrides it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const collapsed = toggled ?? (isClient && readStoredCollapsed());

  const toggle = (): void => {
    const next = !collapsed;

    setToggled(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      /* ignore persist failure */
    }
  };

  return (
    <RailCollapseView
      ariaLabel={ariaLabel}
      collapsed={collapsed}
      collapsedChildren={collapsedChildren}
      collapseLabel={collapseLabel}
      expandLabel={expandLabel}
      onToggle={toggle}
    >
      {children}
    </RailCollapseView>
  );
}
