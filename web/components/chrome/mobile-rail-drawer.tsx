"use client";

import type { LeftRailNavSection } from "@/components/chrome/left-rail-nav";
import type { ReactElement } from "react";

import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { useModalFocusTrap } from "@/components/feedback/use-modal-focus-trap";
import { LeftRailNav } from "@/components/chrome/left-rail-nav";

export function MobileRailDrawer({
  ariaLabel,
  closeLabel,
  comingSoon,
  inboxCount,
  openLabel,
  sections,
}: {
  ariaLabel: string;
  closeLabel: string;
  comingSoon: string;
  inboxCount: number;
  openLabel: string;
  sections: readonly LeftRailNavSection[];
}): ReactElement {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const drawerRef = useRef<HTMLDivElement>(null);

  useModalFocusTrap(drawerRef, () => setOpen(false), open);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="md:hidden">
      <button
        aria-expanded={open}
        aria-label={open ? closeLabel : openLabel}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-line text-mute hover:bg-ivory hover:text-ink"
        data-testid="mobile-rail-toggle"
        title={open ? closeLabel : openLabel}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <Bars3Icon aria-hidden="true" className="h-5 w-5" />
      </button>
      {open ? (
        <div className="fixed inset-0 z-[150]" data-testid="mobile-rail-drawer">
          <button
            aria-label={closeLabel}
            className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)]"
            type="button"
            onClick={() => setOpen(false)}
          />
          <div
            ref={drawerRef}
            aria-label={ariaLabel}
            aria-modal="true"
            className="relative flex h-full w-[min(320px,88vw)] flex-col border-r border-line bg-paper px-4 py-4 shadow-[var(--shadow-lg)]"
            role="dialog"
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute">
                {ariaLabel}
              </span>
              <button
                aria-label={closeLabel}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line text-mute hover:bg-ivory hover:text-ink"
                type="button"
                onClick={() => setOpen(false)}
              >
                <XMarkIcon aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <LeftRailNav
              ariaLabel={ariaLabel}
              comingSoon={comingSoon}
              inboxCount={inboxCount}
              sections={sections}
              variant="expanded"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
