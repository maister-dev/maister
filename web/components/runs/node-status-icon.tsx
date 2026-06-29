import type { ReactElement } from "react";

import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  HandRaisedIcon,
  MinusCircleIcon,
  QuestionMarkCircleIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import clsx from "clsx";

import {
  NODE_STATUS_TONE_CLASS,
  nodeStatusVisual,
} from "@/lib/runs/node-status-visual";

// Heroicon registry keyed by node-status-visual `iconName` (the project-standard
// @heroicons/react/24/outline export names). Phase A surfaces (list / canvas
// chip / selected field) render the localized status as the icon's accessible
// name rather than a dense raw status word.
const ICONS: Record<string, typeof ClockIcon> = {
  ClockIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  XCircleIcon,
  HandRaisedIcon,
  ArrowUturnLeftIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  QuestionMarkCircleIcon,
};

export function NodeStatusIcon({
  status,
  label,
  className,
}: {
  status: string;
  // Localized status text — the icon's accessible name + hover tooltip.
  label: string;
  className?: string;
}): ReactElement {
  const visual = nodeStatusVisual(status);
  const Icon = ICONS[visual.iconName] ?? QuestionMarkCircleIcon;

  // The wrapping span owns the accessible name (aria-label), the native `title`
  // tooltip, and the tone color; the glyph is decorative (aria-hidden) and
  // inherits the color via currentColor. A heroicon `title` PROP would instead
  // emit an SVG <title> child — the span keeps a stable `title=` attribute.
  return (
    <span
      aria-label={label}
      className={clsx(
        "inline-flex shrink-0 items-center",
        NODE_STATUS_TONE_CLASS[visual.tone],
        className,
      )}
      data-node-status={status}
      data-testid="node-status-icon"
      role="img"
      title={label}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </span>
  );
}
