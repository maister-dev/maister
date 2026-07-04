"use client";

import type {
  ExperimentStatus,
  ExperimentVariant,
} from "@/lib/experiments/types";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type ExperimentActionsLabels = {
  launch: string;
  abandon: string;
  launchVariants: string;
  launchReplicates: string;
};

function isTerminal(status: ExperimentStatus): boolean {
  return status === "concluded" || status === "abandoned";
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    code?: string;
  } | null;

  return body?.message ?? body?.code ?? `${response.status}`;
}

export function ExperimentActions({
  projectSlug,
  experimentId,
  status,
  variants,
  labels,
}: {
  projectSlug: string;
  experimentId: string;
  status: ExperimentStatus;
  variants: ExperimentVariant[];
  labels: ExperimentActionsLabels;
}): ReactElement {
  const router = useRouter();
  const [busyAction, setBusyAction] = useState<"launch" | "abandon" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const disabled = busyAction !== null || isTerminal(status);

  async function postAction(
    action: "launch" | "abandon",
    body: Record<string, unknown>,
  ): Promise<void> {
    setBusyAction(action);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${projectSlug}/experiments/${experimentId}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        setError(await readErrorMessage(response));

        return;
      }

      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  function launchPayload(form: HTMLFormElement): Record<string, unknown> {
    const formData = new FormData(form);
    const variant = String(formData.get("variants") ?? "all");
    const replicates = Number(formData.get("replicates") ?? "1");

    return {
      variants: variant === "all" ? "all" : [variant],
      replicates: Number.isInteger(replicates) ? replicates : 1,
    };
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-start justify-end gap-2">
        <form
          className="flex flex-wrap items-end justify-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void postAction("launch", launchPayload(event.currentTarget));
          }}
        >
          <label className="flex flex-col gap-1 text-left">
            <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mute">
              {labels.launchVariants}
            </span>
            <select
              className="h-9 rounded-lg border border-line bg-paper px-2 font-mono text-[11px] text-ink"
              disabled={disabled}
              name="variants"
            >
              <option value="all">{labels.launchVariants}</option>
              {variants.map((variant) => (
                <option key={variant.key} value={variant.key}>
                  {variant.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-left">
            <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-mute">
              {labels.launchReplicates}
            </span>
            <input
              className="h-9 w-20 rounded-lg border border-line bg-paper px-2 font-mono text-[11px] text-ink"
              defaultValue={1}
              disabled={disabled}
              max={10}
              min={1}
              name="replicates"
              type="number"
            />
          </label>
          <button
            className="h-9 rounded-lg border border-amber bg-amber px-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white disabled:opacity-60"
            disabled={disabled}
            type="submit"
          >
            {labels.launch}
          </button>
        </form>
        <button
          className="h-9 rounded-lg border border-line bg-paper px-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink disabled:opacity-60"
          disabled={disabled}
          type="button"
          onClick={() => void postAction("abandon", { stopLiveRuns: true })}
        >
          {labels.abandon}
        </button>
      </div>
      {error ? (
        <p className="m-0 max-w-[280px] text-right font-mono text-[11px] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
