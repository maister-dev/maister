"use client";

import type { ComponentPropsWithoutRef, ReactElement } from "react";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

// Native <details> never closes on an outside click, on Escape, or on
// client-side navigation. In the persistent nav chrome that leaves an open
// dropdown/flyout hanging over the next page. This wraps an uncontrolled
// <details> and closes it imperatively — the `open` attribute still drives
// `group-open:` styling no matter who toggles it, so markup and CSS stay
// untouched. Reuse it for any floating <details>-based popup menu.
export function AutoCloseDetails({
  children,
  ...props
}: ComponentPropsWithoutRef<"details">): ReactElement {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const el = ref.current;

      if (
        el?.open &&
        event.target instanceof Node &&
        !el.contains(event.target)
      ) {
        el.open = false;
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      const el = ref.current;

      if (event.key !== "Escape" || !el?.open) return;
      // Return focus to the trigger when Escape closes the panel from within.
      const refocus =
        document.activeElement instanceof Node &&
        el.contains(document.activeElement);

      el.open = false;
      if (refocus) el.querySelector<HTMLElement>("summary")?.focus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  return (
    <details ref={ref} {...props}>
      {children}
    </details>
  );
}
