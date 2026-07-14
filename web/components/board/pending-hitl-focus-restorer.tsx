"use client";

import type { ReactElement } from "react";

import { useEffect } from "react";

function focusKey(runId: string): string {
  return `maister:pending-hitl-focus:${runId}`;
}

export function requestPendingHitlFocus(runId: string): void {
  window.sessionStorage.setItem(focusKey(runId), "pending");
}

export function PendingHitlFocusRestorer({
  runId,
  pendingHitlIds,
}: {
  runId: string;
  pendingHitlIds: readonly string[];
}): ReactElement | null {
  const pendingHitlKey = pendingHitlIds.join(",");

  useEffect(() => {
    if (window.sessionStorage.getItem(focusKey(runId)) !== "pending") return;

    window.sessionStorage.removeItem(focusKey(runId));

    window.requestAnimationFrame(() => {
      const nextPendingCard = document.querySelector<HTMLElement>(
        '[data-pending-hitl-card="true"]',
      );

      nextPendingCard?.focus();
    });
  }, [pendingHitlKey, runId]);

  return null;
}
