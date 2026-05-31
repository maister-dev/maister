"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

export interface RunTakeoverActionsProps {
  runId: string;
  // "claimable" → NeedsInput review node offering the takeover decision.
  // "working" → run is HumanWorking; show checkout context + Return.
  mode: "claimable" | "working";
  worktreePath: string;
  branch: string;
  // Whether the current session user owns the active claim (gates Return).
  isOwner: boolean;
  canAct: boolean;
}

export function RunTakeoverActions({
  runId,
  mode,
  worktreePath,
  branch,
  isOwner,
  canAct,
}: RunTakeoverActionsProps): ReactElement {
  const t = useTranslations("run");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
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
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(data?.code ?? "CRASH");

        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
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
      // Clipboard denied — the value is still selectable in the field.
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
      <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {t("checkoutContext")}
      </div>
      <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-ivory p-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            {t("branch")}
          </span>
          <input
            readOnly
            className="rounded-[6px] border border-line-soft bg-paper px-2 py-1 font-mono text-[11px] text-ink-2"
            value={branch}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            worktree
          </span>
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="min-w-0 flex-1 rounded-[6px] border border-line-soft bg-paper px-2 py-1 font-mono text-[11px] text-ink-2"
              value={worktreePath}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              className="flex-none rounded-[6px] border border-line bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-mute hover:text-ink-2"
              type="button"
              onClick={() => void copy(worktreePath)}
            >
              {copied ? "✓" : t("copy")}
            </button>
          </div>
        </label>
      </div>

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
