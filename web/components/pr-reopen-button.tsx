"use client";

import type { ReactElement } from "react";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { useFeedback } from "@/components/feedback/feedback-provider";
import { resolveUiErrorMessageKey } from "@/lib/ui-error-message";

export interface PrReopenButtonProps {
  runId: string;
  label: string;
}

// ADR-141: the conflicted-PR reopen action. POSTs the run-scoped
// reopen route (server enforces Done + open/conflicted-PR eligibility → 409 on
// mismatch); refreshes the surface on success. Non-eligible clicks fail closed
// at the server, so the button stays visible whenever a conflict chip shows.
export function PrReopenButton({
  runId,
  label,
}: PrReopenButtonProps): ReactElement {
  const router = useRouter();
  const feedback = useFeedback();
  const t = useTranslations("run");
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  // Failure goes through the shared feedback provider, not a `title` suffix: a
  // title is invisible to a screen reader (the aria-label never changed) and to
  // anyone not hovering — and the COMMONEST failure here is a viewer's 403.
  async function reopen(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${runId}/reopen`, { method: "POST" });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        feedback.error({
          mutationId: `run-reopen:${runId}:failure`,
          message: t(resolveUiErrorMessageKey(data?.code)),
        });
        setBusy(false);

        return;
      }
      startTransition(() => router.refresh());
      setBusy(false);
    } catch {
      feedback.error({
        mutationId: `run-reopen:${runId}:failure`,
        message: t(resolveUiErrorMessageKey(undefined)),
      });
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
      title={label}
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
