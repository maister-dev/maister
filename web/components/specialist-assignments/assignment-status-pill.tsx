import type { ReactElement } from "react";
import type { SpecialistAssignmentStatus } from "@/lib/specialist-assignments/types";

const tone: Record<SpecialistAssignmentStatus, string> = {
  queued: "border-line text-mute",
  active: "border-sky-500/40 text-sky-600 dark:text-sky-300",
  waiting_input: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  waiting_children: "border-sky-500/40 text-sky-600 dark:text-sky-300",
  waiting_resource: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  reconciling: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  awaiting_acceptance:
    "border-violet-500/40 text-violet-600 dark:text-violet-300",
  completed: "border-emerald-500/40 text-emerald-600 dark:text-emerald-300",
  failed: "border-rose-500/40 text-rose-600 dark:text-rose-300",
  cancelled: "border-line text-mute",
};

export function AssignmentStatusPill({
  status,
  label,
}: {
  status: SpecialistAssignmentStatus;
  label: string;
}): ReactElement {
  return (
    <span
      className={`rounded-full border px-3 py-1 text-sm ${tone[status]}`}
      data-status={status}
    >
      {label}
    </span>
  );
}
