"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { CheckoutContext } from "@/components/runs/checkout-context";
import { readApiError } from "@/lib/api-error";

export interface RunTakeoverActionsProps {
  runId: string;
  // "claimable" → NeedsInput review node offering the takeover decision.
  // "working" → run is HumanWorking; show checkout context + Return.
  mode: "claimable" | "working";
  worktreePath: string;
  displayWorktreePath?: string;
  branch: string;
  // Whether the current session user owns the active claim (gates Return).
  isOwner: boolean;
  canAct: boolean;
}

export function RunTakeoverActions({
  runId,
  mode,
  worktreePath,
  displayWorktreePath,
  branch,
  isOwner,
  canAct,
}: RunTakeoverActionsProps): ReactElement {
  const t = useTranslations("run");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: "claim" | "return"): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/runs/${runId}/takeover/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      if (!res.ok) {
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

  const disabled = busy || pending || !canAct;

  if (mode === "claimable") {
    return (
      <div className="flex flex-col gap-2">
        <button
          className={clsx(
            "inline-flex w-max items-center rounded-lg border border-accent-4 bg-accent-4-soft px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-accent-4 hover:bg-[color-mix(in_oklab,var(--accent-4-soft)_70%,var(--paper))]",
            disabled && "opacity-60",
          )}
          disabled={disabled}
          type="button"
          onClick={() => void post("claim")}
        >
          {t("takeOver")}
        </button>
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
      />

      {isOwner ? (
        <button
          className={clsx(
            "inline-flex w-max items-center rounded-lg border border-amber bg-amber px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
            disabled && "opacity-60",
          )}
          disabled={disabled}
          type="button"
          onClick={() => void post("return")}
        >
          {t("return")}
        </button>
      ) : (
        <p className="font-mono text-[11px] text-mute">{t("returnNotOwner")}</p>
      )}
      {error ? (
        <p className="font-mono text-[12px] text-[#d9534f]">{error}</p>
      ) : null}
    </div>
  );
}
