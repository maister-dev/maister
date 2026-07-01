"use client";

import type { TaskPriority } from "@/lib/tasks/criticality";
import type { ReactElement } from "react";

import { PauseIcon, PlayIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface TaskQueueControlsLabels {
  priorityLow: string;
  priorityNormal: string;
  priorityHigh: string;
  priorityUrgent: string;
  pause: string;
  resume: string;
  paused: string;
  error: string;
}

export interface TaskQueueControlsProps {
  slug: string;
  taskNumber: number;
  taskPriority: TaskPriority;
  queuePaused: boolean;
  canAct: boolean;
  labels: TaskQueueControlsLabels;
}

// ADR-121: only the non-default priorities earn a visible badge — `normal` stays
// quiet so the card meta bar isn't noisy for the common case.
const PRIORITY_BADGE: Record<TaskPriority, string | null> = {
  low: "text-mute bg-ivory border-line",
  normal: null,
  high: "text-amber bg-amber-soft border-amber-line",
  urgent: "text-danger bg-ivory border-danger",
};

function priorityLabel(
  priority: TaskPriority,
  labels: TaskQueueControlsLabels,
): string {
  if (priority === "low") return labels.priorityLow;
  if (priority === "high") return labels.priorityHigh;
  if (priority === "urgent") return labels.priorityUrgent;

  return labels.priorityNormal;
}

export function TaskQueueControls({
  slug,
  taskNumber,
  taskPriority,
  queuePaused,
  canAct,
  labels,
}: TaskQueueControlsProps): ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const badgeClass = PRIORITY_BADGE[taskPriority];

  async function togglePause(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/tasks/${taskNumber}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ queuePaused: !queuePaused }),
        },
      );

      if (!res.ok) {
        setError(labels.error);

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
    <div className="flex items-center gap-1.5">
      {badgeClass ? (
        <span
          className={clsx(
            "rounded border px-1.5 py-px font-mono text-[9.5px] font-bold uppercase tracking-[0.08em]",
            badgeClass,
          )}
          data-testid="task-priority-badge"
        >
          {priorityLabel(taskPriority, labels)}
        </span>
      ) : null}
      {queuePaused ? (
        <span
          className="rounded border border-line bg-ivory px-1.5 py-px font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute"
          data-testid="task-queue-paused"
        >
          {labels.paused}
        </span>
      ) : null}
      {canAct ? (
        <button
          aria-label={queuePaused ? labels.resume : labels.pause}
          className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-md border border-line bg-paper text-mute transition hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || pending}
          type="button"
          onClick={() => void togglePause()}
        >
          {queuePaused ? (
            <PlayIcon className="h-3.5 w-3.5" />
          ) : (
            <PauseIcon className="h-3.5 w-3.5" />
          )}
        </button>
      ) : null}
      {error ? (
        <span className="font-mono text-[10px] text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
