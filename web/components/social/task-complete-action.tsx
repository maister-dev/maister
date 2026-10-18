"use client";

import type { ReactElement } from "react";

import { CheckIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { readApiError } from "@/lib/api-error";

export type TaskCompleteActionLabels = {
  complete: string;
  completing: string;
  error: string;
};

export function TaskCompleteAction({
  slug,
  taskNumber,
  expectedRevision,
  labels,
}: {
  slug: string;
  taskNumber: number;
  expectedRevision: number;
  labels: TaskCompleteActionLabels;
}): ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function complete(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/tasks/${taskNumber}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision }),
        },
      );

      if (!response.ok) {
        setError(await readApiError(response, () => labels.error));

        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError(labels.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-paper px-2.5 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="task-complete-action"
        disabled={busy}
        type="button"
        onClick={() => void complete()}
      >
        <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />
        {busy ? labels.completing : labels.complete}
      </button>
      {error ? (
        <span
          aria-live="polite"
          className="max-w-72 font-mono text-[10.5px] text-danger"
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
