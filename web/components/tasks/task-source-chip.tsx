import type { ReactElement } from "react";
import type { TaskSource } from "@/lib/tasks/external-source/model";

import { taskSourceDisplay } from "@/lib/tasks/external-source/model";

// ADR-206: where the task came from. A link only when the provider gave a URL.
export function TaskSourceChip({
  source,
  kindLabel,
}: {
  source: TaskSource;
  kindLabel: string;
}): ReactElement {
  const text = `${kindLabel} ${taskSourceDisplay(source)}`;
  const className =
    "rounded border border-line bg-ivory px-1.5 py-px font-mono font-semibold text-ink";

  return source.url ? (
    <a
      className={`${className} hover:text-amber`}
      data-testid="task-source-chip"
      href={source.url}
      rel="noreferrer"
      target="_blank"
    >
      {text}
    </a>
  ) : (
    <span className={className} data-testid="task-source-chip">
      {text}
    </span>
  );
}
