"use client";

import type { ReactElement } from "react";

import { useEffect, useState } from "react";

// OS-aware shortcut label for the primary launch button. SSR renders the macOS
// glyph (most dev hosts); the client corrects it to "Ctrl K" on non-Apple
// platforms after mount. suppressHydrationWarning absorbs that one-tick swap.
export function LaunchHotkeyHint(): ReactElement {
  const [isMac, setIsMac] = useState(true);

  useEffect(() => {
    setIsMac(/mac|iphone|ipad/i.test(navigator.userAgent));
  }, []);

  return (
    <kbd
      suppressHydrationWarning
      className="rounded bg-white/[0.18] px-1.5 py-[3px] font-mono text-[10px] font-semibold tracking-[0.04em]"
    >
      {isMac ? "⌘K" : "Ctrl K"}
    </kbd>
  );
}
