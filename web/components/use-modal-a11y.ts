"use client";

import type { RefObject } from "react";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The modal interaction `web/CLAUDE.md` requires: initial focus, focus
 * containment, Escape-to-close, body scroll lock, and focus restoration.
 *
 * `aria-modal="true"` alone implements NONE of it — it only tells assistive
 * tech the intent. A dialog carrying just that attribute leaves every
 * background control in the tab order, so a keyboard user tabbing out of an
 * edit dialog can reach and activate the row's destructive Revoke button.
 *
 * Extracted so a surface with its own visual design gets the behaviour without
 * adopting another surface's markup.
 */
export function useModalA11y(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
): void {
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;

    const restoreFocusTo = document.activeElement as HTMLElement | null;
    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusTo?.focus();
    };
  }, [dialogRef, active]);
}
