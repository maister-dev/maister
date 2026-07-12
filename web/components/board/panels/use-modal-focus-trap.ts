import type { RefObject } from "react";

import { useEffect, useRef } from "react";

// ADR-129 (T6.2): the shared modal focus contract — initial focus, Tab focus
// cycling, Escape-to-close, body scroll-lock, and focus restore on unmount.
// Extracted from the byte-identical effect that ProjectMcpModal
// (`mcp-modal.tsx`) and the bind/overlay `ModalFrame` (`mcp-bind-dialogs.tsx`)
// both carried, so the two cannot drift apart. The caller owns the dialog ref
// (for its JSX) and passes its `onClose`.
export function useModalFocusTrap<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  onClose: () => void,
): void {
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
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
      restoreFocusRef.current?.focus();
    };
  }, [dialogRef]);
}
