"use client";

import type { ReactElement } from "react";

import { PauseCircleIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { readApiError } from "@/lib/api-error";

export interface NodeInterruptTriggerProps {
  runId: string;
  canAct: boolean;
}

// ADR-161: pause ONE live agent node. The body is empty — the node, its
// attempt, and the supervisor session are all resolved server-side, so this
// control carries no identifiers the server would have to trust.
export function NodeInterruptTrigger({
  runId,
  canAct,
}: NodeInterruptTriggerProps): ReactElement {
  const t = useTranslations("nodeInterrupt");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = busy || pending || !canAct;

  async function interrupt(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/runs/${runId}/node-interrupt`, {
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

  return (
    <div className="flex flex-col gap-2">
      <button
        aria-label={t("interruptNode")}
        className={clsx(
          "inline-flex w-max items-center gap-1.5 rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:text-ink",
          disabled && "opacity-60",
        )}
        disabled={disabled}
        type="button"
        onClick={() => void interrupt()}
      >
        <PauseCircleIcon aria-hidden className="size-4" />
        {t("interruptNode")}
      </button>
      {error ? (
        <p className="font-mono text-[12px] text-[#d9534f]">{error}</p>
      ) : null}
    </div>
  );
}
