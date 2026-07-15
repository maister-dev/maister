"use client";

import type { ReactElement } from "react";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface PrReopenButtonProps {
  runId: string;
  label: string;
}

// ADR-140 (Task 17): the conflicted-PR reopen action. POSTs the run-scoped
// reopen route (server enforces Done + open/conflicted-PR eligibility → 409 on
// mismatch); refreshes the surface on success. Non-eligible clicks fail closed
// at the server, so the button stays visible whenever a conflict chip shows.
export function PrReopenButton({
  runId,
  label,
}: PrReopenButtonProps): ReactElement {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function reopen(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/runs/${runId}/reopen`, { method: "POST" });

      if (!res.ok) {
        setFailed(true);
        setBusy(false);

        return;
      }
      startTransition(() => router.refresh());
      setBusy(false);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <button
      aria-label={label}
      // `relative z-10` is REQUIRED: on a board flight-card a stretched
      // `absolute inset-0 z-0` link covers the whole card, and every interactive
      // child must sit above it (card convention) or it can never be clicked.
      className="relative z-10 ml-0.5 inline-flex items-center hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      data-testid="pr-reopen"
      disabled={busy}
      title={failed ? `${label} ✗` : label}
      type="button"
      onClick={(e) => {
        // The chip usually sits inside a card-level link; keep the click local.
        e.preventDefault();
        e.stopPropagation();
        void reopen();
      }}
    >
      <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
  );
}
