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
  addressedCheckout?: Readonly<{ hostName: string; handle: string }>;
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
  addressedCheckout,
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
      {addressedCheckout ? (
        <div className="min-w-0 space-y-2 rounded-lg border border-line bg-ivory px-3 py-2">
          <p className="text-sm font-medium text-ink">
            {t("takeoverSupervisor", { name: addressedCheckout.hostName })}
          </p>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-mute">
            {t("takeoverWorkspaceHandle")}
            <input
              readOnly
              value={addressedCheckout.handle}
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 rounded-md border border-line-soft bg-paper px-2 py-1 font-mono text-xs text-ink"
            />
          </label>
          <p className="text-xs text-mute">{t("takeoverCommitOnSupervisor")}</p>
        </div>
      ) : (
        <CheckoutContext
          branch={branch}
          displayWorktreePath={displayWorktreePath}
          worktreePath={worktreePath}
        />
      )}

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
        <p className="font-mono text-[12px] text-[#d9534f]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
