"use client";

import type { HitlOption } from "@/lib/queries/hitl";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import clsx from "clsx";

export interface HitlActionsProps {
  runId: string;
  hitlRequestId: string;
  kind: "permission" | "form" | "human";
  options: HitlOption[];
  canAct: boolean;
  snoozeLabel: string;
  reviewLabel: string;
}

export function HitlActions({
  runId,
  hitlRequestId,
  kind,
  options,
  canAct,
  snoozeLabel,
  reviewLabel,
}: HitlActionsProps): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function respond(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/runs/${runId}/hitl/${hitlRequestId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

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

  const disabled = busy || pending || !canAct;

  if (kind === "permission" && canAct) {
    return (
      <div className="flex flex-none gap-1.5">
        {error ? (
          <span className="self-center font-mono text-[10px] font-bold uppercase text-amber">
            {error}
          </span>
        ) : null}
        {options.map((opt) => (
          <button
            key={opt.optionId}
            className={clsx(
              "rounded-lg border px-3 py-[7px] font-mono text-[10.5px] font-bold uppercase leading-none tracking-[0.06em]",
              opt.optionId.includes("deny")
                ? "border-line bg-paper text-mute hover:border-mute hover:text-ink-2"
                : "border-amber bg-amber text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2",
              disabled && "opacity-60",
            )}
            disabled={disabled}
            type="button"
            onClick={() => void respond({ optionId: opt.optionId })}
          >
            {opt.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-none gap-1.5">
      {error ? (
        <span className="self-center font-mono text-[10px] font-bold uppercase text-amber">
          {error}
        </span>
      ) : null}
      <button
        className="rounded-lg border border-line bg-paper px-3 py-[7px] font-mono text-[10.5px] font-bold uppercase leading-none tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
        type="button"
        onClick={() => startTransition(() => router.refresh())}
      >
        {snoozeLabel}
      </button>
      <a
        className="rounded-lg border border-amber bg-amber px-3 py-[7px] font-mono text-[10.5px] font-bold uppercase leading-none tracking-[0.06em] text-white shadow-[0_4px_12px_-6px_var(--amber)] hover:bg-amber-2"
        href={`/runs/${runId}`}
      >
        {reviewLabel} →
      </a>
    </div>
  );
}
