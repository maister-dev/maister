import type { ReactElement } from "react";
import type { RunStreamLifecycleKind } from "@/lib/run-stream-controller";

import clsx from "clsx";

export interface RunStreamLivenessLabels {
  disconnected: string;
  live: string;
  reconnect: string;
  reconnecting: string;
}

function livenessLabel(
  liveness: RunStreamLifecycleKind,
  labels: RunStreamLivenessLabels,
): string {
  if (liveness === "live") return labels.live;
  if (liveness === "disconnected") return labels.disconnected;

  return labels.reconnecting;
}

export function RunStreamLiveness({
  labels,
  liveness,
  onReconnect,
}: {
  labels: RunStreamLivenessLabels;
  liveness: RunStreamLifecycleKind;
  onReconnect: () => void;
}): ReactElement {
  const reconnectable = liveness === "disconnected";

  return (
    <div aria-live="polite" className="inline-flex items-center gap-2">
      <span
        className={clsx(
          "rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold",
          liveness === "live"
            ? "border-accent-4 bg-accent-4-soft text-accent-4"
            : "border-amber-line bg-amber-soft text-amber",
        )}
        data-testid="run-stream-liveness"
      >
        {livenessLabel(liveness, labels)}
      </span>
      {reconnectable ? (
        <button
          className="font-mono text-[10px] font-semibold text-amber underline underline-offset-2"
          type="button"
          onClick={onReconnect}
        >
          {labels.reconnect}
        </button>
      ) : null}
    </div>
  );
}
