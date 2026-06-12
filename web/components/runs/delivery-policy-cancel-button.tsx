"use client";

import type { ReactElement } from "react";

import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Props = {
  runId: string;
  labels: {
    cancel: string;
    cancelling: string;
    error: string;
  };
};

export function DeliveryPolicyCancelButton({
  labels,
  runId,
}: Props): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function cancel(): Promise<void> {
    setBusy(true);
    setError(false);

    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/delivery-policy`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "switch_to_manual" }),
        },
      );

      if (!response.ok) {
        setError(true);

        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        className="border-amber-line bg-amber-soft font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-amber"
        isDisabled={busy || pending}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => void cancel()}
      >
        {busy || pending ? labels.cancelling : labels.cancel}
      </Button>
      {error ? (
        <span className="font-mono text-[10px] text-red-700">
          {labels.error}
        </span>
      ) : null}
    </div>
  );
}
