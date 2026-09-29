import type { ReactElement } from "react";
import type { PlatformStatus } from "@/types/platform-status";

import clsx from "clsx";
import Link from "next/link";

export type PlatformStatusLabels = {
  ready: string;
  behind: string;
  unavailable: string;
};

export function platformStatusLabel(
  status: PlatformStatus,
  labels: PlatformStatusLabels,
): string {
  if (status.kind !== "ready") return labels.unavailable;

  return status.lag?.status === "behind" ? labels.behind : labels.ready;
}

export function platformStatusDotClass(status: PlatformStatus): string {
  if (status.kind !== "ready") return "bg-red-500";

  return status.lag?.status === "behind"
    ? "bg-amber"
    : "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]";
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
  href,
}: {
  status: PlatformStatus;
  labels: PlatformStatusLabels;
  className?: string;
  href?: string;
}): ReactElement {
  // `min-w-0` + `truncate`: where a narrow parent squeezes the pill (the footer
  // at 390px), the label gives way by CSS and stays whole in the DOM.
  const content = (
    <span
      className={clsx("inline-flex min-w-0 items-center gap-1.5", className)}
      data-testid="rail-platform-status"
      title={status.kind === "unavailable" ? status.message : undefined}
    >
      <PlatformStatusDot className="shrink-0" status={status} />
      <b className="truncate font-semibold text-ink">
        {platformStatusLabel(status, labels)}
      </b>
    </span>
  );

  return href ? (
    <Link
      aria-label={platformStatusLabel(status, labels)}
      className="inline-flex min-w-0"
      data-testid="rail-platform-status-link"
      href={href}
    >
      {content}
    </Link>
  ) : (
    content
  );
}
