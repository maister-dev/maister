import type { RefObject } from "react";

import { useEffect, useRef } from "react";

import { useLatestRef } from "@/lib/use-latest-ref";

export function useModalFocusTrap<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  onClose: () => void,
  enabled = true,
): void {
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useLatestRef(onClose);

  useEffect(() => {
    if (!enabled) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    (focusable()[0] ?? dialogRef.current)?.focus();

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

      if (items.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();

        return;
      }

      const first = items[0];
      const last = items[items.length - 1];

      if (!items.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();

        return;
      }

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
      restoreFocusRef.current?.focus();
    };
  }, [dialogRef, enabled]);
}
