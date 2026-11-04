"use client";

import type { ReactElement } from "react";
import type { TaskQualificationSummary } from "@/lib/tasks/qualification-queries";

import { useTranslations } from "next-intl";

/** Safe read-only details; absence of model-start proof never implies pre-model failure. */
export function TaskQualificationSourceFailureNotice({
  failure,
}: {
  failure: NonNullable<TaskQualificationSummary["sourceFailure"]>;
}): ReactElement {
  const t = useTranslations("launch");

  return (
    <p
      className="text-sm text-ink-2"
      data-testid="task-qualification-source-failure"
      role="note"
    >
      {failure.modelStarted === false
        ? `${t("admission.beforeModelFailure")} `
        : null}
      <a
        className="underline"
        href={`/runs/${encodeURIComponent(failure.runId)}`}
      >
        {t("admission.openFailure")}
      </a>
    </p>
  );
}
