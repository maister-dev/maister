"use client";

import type { ReactElement } from "react";

import {
  ArrowUturnLeftIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  HandRaisedIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { CheckoutContext } from "@/components/runs/checkout-context";
import { readApiError } from "@/lib/api-error";

// ADR-159: the copyable remediation a non-fast-forward refusal carries. The
// server owns every value here — the client only renders it.
export type ReworkNonFastForwardDetails = {
  command: string;
  localSha: string;
  remoteSha: string;
  aheadBy: number;
  behindBy: number;
  instructions: string[];
};

export interface RunContinuationActionsProps {
  runId: string;
  // Server-owned availability (never re-derived here).
  reworkClaimAvailable: boolean;
  disabledReason: string | null;
  reentryNodeId: string | null;
  // Non-null while a rework claim is open.
  claimOwnerUserId: string | null;
  viewerUserId: string | null;
  // The REAL path (clipboard target); `displayWorktreePath` is the abbreviated
  // form rendered in the field. See CheckoutContext for why they are separate.
  worktreePath: string;
  displayWorktreePath?: string;
  branch: string;
  canAct: boolean;
}

type Action = "claim" | "return" | "release";

function isNonFastForward(
  value: unknown,
): value is ReworkNonFastForwardDetails {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;

  return (
    typeof d.command === "string" &&
    typeof d.localSha === "string" &&
    typeof d.remoteSha === "string" &&
    Array.isArray(d.instructions)
  );
}

export function RunContinuationActions({
  runId,
  reworkClaimAvailable,
  disabledReason,
  reentryNodeId,
  claimOwnerUserId,
  viewerUserId,
  worktreePath,
  displayWorktreePath,
  branch,
  canAct,
}: RunContinuationActionsProps): ReactElement {
  const t = useTranslations("runContinuation");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonFf, setNonFf] = useState<ReworkNonFastForwardDetails | null>(null);

  const claimed = claimOwnerUserId !== null;
  const isOwner = claimed && claimOwnerUserId === viewerUserId;
  const disabled = busy || pending || !canAct;

  async function post(action: Action): Promise<void> {
    setBusy(true);
    setError(null);
    setNonFf(null);

    try {
      const res = await fetch(`/api/runs/${runId}/rework-claim/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      if (!res.ok) {
        // Read the body once: a non-FF refusal carries structured remediation
        // the operator can copy, which the generic error string cannot express.
        const cloned = res.clone();

        try {
          const body: unknown = await cloned.json();
          const details = (body as { details?: unknown })?.details;

          if (isNonFastForward(details)) setNonFf(details);
        } catch {
          // fall through to the localized generic error
        }
        setError(await readApiError(res, tApiErrors));

        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError(tApiErrors("requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — the value stays selectable in the field.
    }
  }

  const buttonBase =
    "inline-flex w-max items-center gap-1.5 rounded-lg border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em]";

  if (!claimed) {
    return (
      <div className="flex flex-col gap-2">
        <button
          aria-label={t("takeForRework")}
          className={clsx(
            buttonBase,
            "border-accent-4 bg-accent-4-soft text-accent-4 hover:bg-[color-mix(in_oklab,var(--accent-4-soft)_70%,var(--paper))]",
            (disabled || !reworkClaimAvailable) && "opacity-60",
          )}
          disabled={disabled || !reworkClaimAvailable}
          title={disabledReason ?? undefined}
          type="button"
          onClick={() => void post("claim")}
        >
          <HandRaisedIcon aria-hidden className="size-4" />
          {t("takeForRework")}
        </button>
        {!reworkClaimAvailable && disabledReason ? (
          <p className="font-mono text-[11px] text-mute">{disabledReason}</p>
        ) : null}
        {reworkClaimAvailable && reentryNodeId ? (
          <p className="font-mono text-[11px] text-mute">
            {t("reentryAt", { node: reentryNodeId })}
          </p>
        ) : null}
        {error ? (
          <p className="font-mono text-[12px] text-[#d9534f]">{error}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <CheckoutContext
        branch={branch}
        displayWorktreePath={displayWorktreePath}
        worktreePath={worktreePath}
      >
        {reentryNodeId ? (
          <p className="font-mono text-[11px] text-mute">
            {t("reentryAt", { node: reentryNodeId })}
          </p>
        ) : null}
      </CheckoutContext>

      {isOwner ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            aria-label={t("returnToFlow")}
            className={clsx(
              buttonBase,
              "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
              disabled && "opacity-60",
            )}
            disabled={disabled}
            type="button"
            onClick={() => void post("return")}
          >
            <ArrowUturnLeftIcon aria-hidden className="size-4" />
            {t("returnToFlow")}
          </button>
          <button
            aria-label={t("release")}
            className={clsx(
              buttonBase,
              "border-line bg-paper text-mute hover:text-ink-2",
              disabled && "opacity-60",
            )}
            disabled={disabled}
            type="button"
            onClick={() => void post("release")}
          >
            <XMarkIcon aria-hidden className="size-4" />
            {t("release")}
          </button>
        </div>
      ) : (
        <p className="font-mono text-[11px] text-mute">{t("notOwner")}</p>
      )}

      {nonFf ? (
        <div className="flex flex-col gap-2 rounded-[10px] border border-amber bg-amber-soft p-3">
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink-2">
            {t("nonFastForwardTitle")}
          </p>
          <p className="font-mono text-[11px] text-ink-2">
            {t("nonFastForwardBody", {
              aheadBy: nonFf.aheadBy,
              behindBy: nonFf.behindBy,
            })}
          </p>
          <pre className="overflow-x-auto rounded-[6px] border border-line-soft bg-paper p-2 font-mono text-[10.5px] text-ink-2">
            {[nonFf.command, ...nonFf.instructions].join("\n")}
          </pre>
          <button
            aria-label={t("copyInstructions")}
            className="inline-flex w-max items-center gap-1.5 rounded-[6px] border border-line bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-mute hover:text-ink-2"
            type="button"
            onClick={() =>
              void copy([nonFf.command, ...nonFf.instructions].join("\n"))
            }
          >
            {copied ? (
              <CheckIcon aria-hidden className="size-3.5 text-[#2f9e44]" />
            ) : (
              <ClipboardDocumentIcon aria-hidden className="size-3.5" />
            )}
            {t("copyInstructions")}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="font-mono text-[12px] text-[#d9534f]">{error}</p>
      ) : null}
    </div>
  );
}
