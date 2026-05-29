import type { ReactElement } from "react";
import type { PlatformStatus } from "@/types/platform-status";

import clsx from "clsx";

export type PlatformStatusLabels = {
  ready: string;
  unavailable: string;
};

export function platformStatusLabel(
  status: PlatformStatus,
  labels: PlatformStatusLabels,
): string {
  return status.kind === "ready" ? labels.ready : labels.unavailable;
}

export function platformStatusDotClass(status: PlatformStatus): string {
  return status.kind === "ready"
    ? "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]"
    : "bg-amber";
}

export function PlatformStatusDot({
  status,
  className,
}: {
  status: PlatformStatus;
  className?: string;
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "h-1.5 w-1.5 rounded-full",
        platformStatusDotClass(status),
        className,
      )}
    />
  );
}

export function PlatformStatusPill({
  status,
  labels,
  className,
}: {
  status: PlatformStatus;
  labels: PlatformStatusLabels;
  className?: string;
}): ReactElement {
  return (
    <span
      className={clsx("inline-flex items-center gap-1.5", className)}
      title={status.kind === "unavailable" ? status.message : undefined}
    >
      <PlatformStatusDot status={status} />
      <b className="font-semibold text-ink">
        {platformStatusLabel(status, labels)}
      </b>
    </span>
  );
}
