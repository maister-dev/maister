import { useTranslations } from "next-intl";

import {
  TASK_DISPLAY_STATUS,
  type TaskDisplayStatusKey,
  type TaskDisplayTone,
} from "@/lib/tasks/task-display-status";

const TONE_STYLE: Record<TaskDisplayTone, string> = {
  neutral: "bg-ivory text-mute",
  accent: "bg-accent-2-soft text-accent-2",
  warning: "bg-cv-amber-soft text-cv-amber",
  danger: "bg-danger-soft text-danger",
  success: "bg-good-soft text-good",
};

export function TaskStatusChip({ status }: { status: TaskDisplayStatusKey }) {
  const t = useTranslations("taskDisplayStatus");
  const { tone } = TASK_DISPLAY_STATUS[status];

  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold ${TONE_STYLE[tone]}`}
      data-task-status={status}
      data-tone={tone}
    >
      {t(status)}
    </span>
  );
}
