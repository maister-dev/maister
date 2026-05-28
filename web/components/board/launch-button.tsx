"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import clsx from "clsx";

export interface LaunchButtonProps {
  taskId: string;
  label: string;
}

export function LaunchButton({
  taskId,
  label,
}: LaunchButtonProps): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
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

  return (
    <button
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border border-transparent px-[9px] py-[5px] font-mono text-[10px] font-bold uppercase leading-none tracking-[0.06em] text-amber transition-all",
        "group-hover/task:border-amber-line group-hover/task:bg-amber-soft",
        "hover:!border-amber hover:!bg-amber hover:!text-white",
        (busy || pending) && "opacity-60",
      )}
      disabled={busy || pending}
      title={error ? error : undefined}
      type="button"
      onClick={() => void onClick()}
    >
      {error ? error : label}
    </button>
  );
}
