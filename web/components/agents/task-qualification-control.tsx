"use client";

import type { ReactElement } from "react";
import type {
  TaskQualificationSummary,
  TaskQualificationHistoryItem,
} from "@/lib/tasks/qualification-queries";
import type { ActivityPage } from "@/lib/agents/activity-queries";
import type { HumanAssessmentDraft } from "@/lib/tasks/human-assessment-schema";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { HumanAssessmentForm } from "@/components/agents/human-assessment-form";
import { TaskQualificationSourceFailureNotice } from "@/components/agents/task-qualification-source-failure-notice";

const button =
  "inline-flex min-h-8 items-center rounded-lg border border-line bg-ivory px-3 text-xs font-semibold text-ink disabled:opacity-50";

export function TaskQualificationControl({
  summary,
  taskId,
  slug,
  canAct,
}: {
  summary: TaskQualificationSummary;
  taskId: string;
  slug: string;
  canAct: boolean;
}): ReactElement {
  const t = useTranslations("taskQualification");
  const launchT = useTranslations("launch");
  const router = useRouter();
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [history, setHistory] =
    useState<ActivityPage<TaskQualificationHistoryItem> | null>(null);
  const [draft, setDraft] = useState<HumanAssessmentDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const endpoint = `/api/projects/${slug}/tasks/${taskId}`;
  const load = async (cursor?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${endpoint}/qualifications${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`,
      );

      if (!response.ok) {
        setError(t(response.status === 403 ? "permission" : "loadError"));

        return;
      }
      setHistory(
        (await response.json()) as ActivityPage<TaskQualificationHistoryItem>,
      );
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  };
  const openAssessment = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${endpoint}/human-assessment`);

      if (!response.ok) {
        setError(t(response.status === 403 ? "permission" : "loadError"));

        return;
      }
      setDraft((await response.json()) as HumanAssessmentDraft);
      setAssessmentOpen(true);
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="space-y-3 rounded-xl border border-line bg-paper p-4"
      data-testid="task-qualification"
    >
      <h2 className="font-semibold">{t("title")}</h2>
      <p className="text-sm">
        {t(`mode.${summary.mode}`)} ·{" "}
        {t(`decision.${summary.decision ?? "unassessed"}`)} ·{" "}
        {t(`freshness.${summary.freshness}`)}
      </p>
      <p className="text-xs text-mute">
        {t("revision", {
          input: summary.inputRevision,
          assessment: summary.qualificationRevision ?? 0,
        })}
      </p>
      {summary.candidate ? (
        <p className="text-sm">
          {t(`publication.${summary.candidate.publicationState}`)}
        </p>
      ) : null}
      {summary.sourceFailure ? (
        <div className="space-y-2">
          <p className="text-sm">{launchT("admission.triageFailed")}</p>
          <TaskQualificationSourceFailureNotice
            failure={summary.sourceFailure}
          />
        </div>
      ) : null}
      {summary.nextActions.length ? (
        <ul className="list-disc pl-5 text-sm">
          {summary.nextActions.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-mute">{t("freshnessHint")}</p>
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? <p role="status">{t("saved")}</p> : null}
      {canAct ? (
        <>
          <button
            className={button}
            disabled={busy}
            type="button"
            onClick={() => void load()}
          >
            {t("viewEvidence")}
          </button>
          {history ? (
            <>
              <ul className="space-y-3">
                {history.items.map((item) => (
                  <li
                    key={item.qualificationId}
                    className="rounded-lg border border-line p-3"
                  >
                    <p className="text-sm">
                      #{item.qualificationRevision} ·{" "}
                      {t(`decision.${item.decision}`)} ·{" "}
                      {t(`publication.${item.publicationState}`)}
                    </p>
                    <p className="break-all font-mono text-xs text-mute">
                      {item.evidenceTarget} @{" "}
                      {item.evidenceSha ?? t("shaUnavailable")}
                    </p>
                    {item.runId ? (
                      <Link
                        className="text-xs underline"
                        href={`/runs/${item.runId}`}
                      >
                        {t("sourceRun")}
                      </Link>
                    ) : null}
                    <details>
                      <summary className="cursor-pointer text-sm">
                        {t("checksTitle")}
                      </summary>
                      <ul className="space-y-2 py-2">
                        {item.qualification.checks.map((check) => (
                          <li key={check.dimension} className="text-sm">
                            <strong>
                              {t(`dimension.${check.dimension}`)}:{" "}
                              {t(`checkState.${check.state}`)}
                            </strong>
                            <p>{check.rationale}</p>
                            {check.evidenceIds.map((id) => {
                              const ref = item.qualification.evidenceRefs.find(
                                (ref) => ref.id === id,
                              );

                              return (
                                <p
                                  key={id}
                                  className="break-all font-mono text-xs text-mute"
                                >
                                  {ref?.reference ?? id}
                                </p>
                              );
                            })}
                          </li>
                        ))}
                      </ul>
                      {item.qualification.nextActions.map((action, index) => (
                        <p key={index} className="text-sm">
                          {action}
                        </p>
                      ))}
                    </details>
                    <details>
                      <summary className="cursor-pointer text-sm">
                        {t("authoring.structuredResult")}
                      </summary>
                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
                        {JSON.stringify(item.qualification, null, 2)}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
              {history.nextCursor ? (
                <button
                  className={button}
                  disabled={busy}
                  type="button"
                  onClick={() => void load(history.nextCursor!)}
                >
                  {t("older")}
                </button>
              ) : null}
            </>
          ) : null}
          <button
            className={button}
            disabled={busy}
            type="button"
            onClick={() => void openAssessment()}
          >
            {t("humanAssessment")}
          </button>
          {assessmentOpen && draft ? (
            <HumanAssessmentForm
              endpoint={`${endpoint}/human-assessment`}
              initialDraft={draft}
              slug={slug}
              onClose={() => setAssessmentOpen(false)}
              onSaved={() => {
                setAssessmentOpen(false);
                setSaved(true);
                router.refresh();
                void load();
              }}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
