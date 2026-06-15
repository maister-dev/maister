"use client";

import type { ReactElement, ReactNode } from "react";

import { useEffect, useState } from "react";
import clsx from "clsx";

const STORAGE_KEY = "maister:rail-collapsed";

// Pure presentational shell (exported for tests): the `<aside>` + the collapse
// toggle. Expanded → full 260px rail with its content; collapsed → a 48px strip
// with only the toggle (content unmounted) so the canvas-heavy editor gets width.
// The layout's `auto` rail column follows the aside's own width — no global CSS.
export function RailCollapseView({
  collapsed,
  onToggle,
  collapseLabel,
  expandLabel,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  collapseLabel: string;
  expandLabel: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <aside
      aria-label="Sections & active workspaces"
      className={clsx(
        "sticky top-[60px] z-[100] hidden h-[calc(100vh-60px-56px)] flex-col self-start overflow-x-hidden border-r border-line bg-paper pb-0 pt-2.5 md:flex",
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
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
            viewBox="0 0 16 16"
          >
            {collapsed ? (
              <path d="M6 4l4 4-4 4" />
            ) : (
              <path d="M10 4l-4 4 4 4" />
            )}
          </svg>
        </button>
      </div>
      {collapsed ? null : (
        <div
          className="mt-2.5 flex min-h-0 flex-1 flex-col gap-3.5"
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
  collapseLabel,
  expandLabel,
  children,
}: {
  collapseLabel: string;
  expandLabel: string;
  children: ReactNode;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "true") {
        setCollapsed(true);
      }
    } catch {
      /* localStorage unavailable (private mode) — stay expanded */
    }
  }, []);

  const toggle = (): void => {
    const next = !collapsed;

    setCollapsed(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    } catch {
      /* ignore persist failure */
    }
    // eslint-disable-next-line no-console
    console.debug("[leftRail] toggle", { collapsed: next });
  };

  return (
    <RailCollapseView
      collapseLabel={collapseLabel}
      collapsed={collapsed}
      expandLabel={expandLabel}
      onToggle={toggle}
    >
      {children}
    </RailCollapseView>
  );
}
