"use client";

import type { ReactElement } from "react";
import type {
  TaskQualificationSummary,
  TaskQualificationHistoryItem,
} from "@/lib/tasks/qualification-queries";
import type { ActivityPage } from "@/lib/agents/activity-queries";
import type { TaskQualificationValue } from "@/lib/tasks/qualification-types";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { QUALIFICATION_DIMENSIONS } from "@/lib/tasks/qualification-types";
import { taskQualificationWriteSchema } from "@/lib/tasks/qualification-schema";

const button =
  "inline-flex min-h-8 items-center rounded-lg border border-line bg-ivory px-3 text-xs font-semibold text-ink disabled:opacity-50";
const field =
  "mt-1 block w-full rounded-lg border border-line bg-paper p-2 text-sm";
const emptyValue: TaskQualificationValue = {
  schemaVersion: 1,
  requestType: "feature",
  decision: "needs_review",
  checks: QUALIFICATION_DIMENSIONS.map((dimension) => ({
    dimension,
    state: "unknown",
    rationale: "",
    evidenceIds: [],
  })),
  reasonCodes: [],
  nextActions: [],
  evidenceRefs: [],
};

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
  const router = useRouter();
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [history, setHistory] =
    useState<ActivityPage<TaskQualificationHistoryItem> | null>(null);
  const [value, setValue] = useState<TaskQualificationValue>(emptyValue);
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [acceptedRequest, setAcceptedRequest] = useState<ReturnType<
    typeof taskQualificationWriteSchema.parse
  > | null>(null);
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
  const save = async (): Promise<void> => {
    setError(null);
    setSaved(false);
    const parsed = taskQualificationWriteSchema.safeParse(
      acceptedRequest ?? {
        requestKey: crypto.randomUUID(),
        expectedInputRevision: summary.inputRevision,
        expectedQualificationRevision: summary.qualificationRevision,
        qualification: {
          ...value,
          evidenceRefs: evidence.trim()
            ? evidence.split("\n").map((line) => {
                const [id, kind, ...reference] = line.split("|");

                return {
                  id: id.trim(),
                  kind: kind?.trim(),
                  reference: reference.join("|").trim(),
                };
              })
            : [],
        },
      },
    );

    if (!parsed.success) {
      setError(t("invalid"));

      return;
    }
    setAcceptedRequest(parsed.data);
    setBusy(true);
    try {
      const response = await fetch(`${endpoint}/qualification`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!response.ok) {
        setError(
          t(
            response.status === 409
              ? "conflict"
              : response.status === 403
                ? "permission"
                : "saveError",
          ),
        );
        if (response.status < 500) setAcceptedRequest(null);

        return;
      }
      setSaved(true);
      setAssessmentOpen(false);
      setAcceptedRequest(null);
      router.refresh();
      await load();
    } catch {
      setError(t("unknownWrite"));
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
            type="button"
            onClick={() => setAssessmentOpen(true)}
          >
            {t("humanAssessment")}
          </button>
          {assessmentOpen ? (
            <ConfirmDialog
              body={t("humanHint")}
              busy={busy}
              cancelLabel={t("close")}
              testId="task-qualification-dialog"
              title={t("humanAssessment")}
              titleId={`qualification-${taskId}`}
              onClose={() => setAssessmentOpen(false)}
            >
              {error ? (
                <p className="text-sm text-red-700" role="alert">
                  {error}
                </p>
              ) : null}
              <fieldset
                className="space-y-3"
                disabled={busy || acceptedRequest !== null}
              >
                <label className="block text-sm">
                  {t("requestType")}
                  <select
                    aria-label={t("requestType")}
                    className={field}
                    value={value.requestType}
                    onChange={(event) =>
                      setValue({
                        ...value,
                        requestType: event.target
                          .value as TaskQualificationValue["requestType"],
                      })
                    }
                  >
                    {["bug", "feature", "maintenance", "question"].map(
                      (type) => (
                        <option key={type} value={type}>
                          {t(`type.${type}`)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="block text-sm">
                  {t("decisionLabel")}
                  <select
                    aria-label={t("decisionLabel")}
                    className={field}
                    value={value.decision}
                    onChange={(event) =>
                      setValue({
                        ...value,
                        decision: event.target
                          .value as TaskQualificationValue["decision"],
                      })
                    }
                  >
                    {[
                      "ready",
                      "needs_information",
                      "needs_review",
                      "not_actionable",
                    ].map((decision) => (
                      <option key={decision} value={decision}>
                        {t(`decision.${decision}`)}
                      </option>
                    ))}
                  </select>
                </label>
                {value.checks.map((check, index) => (
                  <fieldset
                    key={check.dimension}
                    className="space-y-2 rounded-lg border border-line p-3"
                  >
                    <legend className="px-1 text-sm font-semibold">
                      {t(`dimension.${check.dimension}`)}
                    </legend>
                    <label className="block text-xs">
                      {t("checkLabel")}
                      <select
                        aria-label={t("checkLabel")}
                        className={field}
                        value={check.state}
                        onChange={(event) =>
                          setValue({
                            ...value,
                            checks: value.checks.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    state: event.target
                                      .value as typeof check.state,
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        {[
                          "pass",
                          "fail",
                          "unknown",
                          ...(check.dimension === "bug_evidence" &&
                          value.requestType !== "bug"
                            ? ["not_applicable"]
                            : []),
                        ].map((state) => (
                          <option key={state} value={state}>
                            {t(`checkState.${state}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs">
                      {t("rationale")}
                      <textarea
                        className={field}
                        maxLength={2000}
                        value={check.rationale}
                        onChange={(event) =>
                          setValue({
                            ...value,
                            checks: value.checks.map((item, i) =>
                              i === index
                                ? { ...item, rationale: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="block text-xs">
                      {t("checkEvidence")}
                      <input
                        className={field}
                        value={check.evidenceIds.join(", ")}
                        onChange={(event) =>
                          setValue({
                            ...value,
                            checks: value.checks.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    evidenceIds: event.target.value
                                      .split(",")
                                      .map((id) => id.trim())
                                      .filter(Boolean),
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                  </fieldset>
                ))}
                <label className="block text-sm">
                  {t("evidenceInput")}
                  <textarea
                    className={field}
                    maxLength={16384}
                    rows={3}
                    value={evidence}
                    onChange={(event) => setEvidence(event.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  {t("reasonInput")}
                  <input
                    className={field}
                    value={value.reasonCodes.join(", ")}
                    onChange={(event) =>
                      setValue({
                        ...value,
                        reasonCodes: event.target.value
                          .split(",")
                          .map((code) => code.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label className="block text-sm">
                  {t("nextActions")}
                  <textarea
                    className={field}
                    value={value.nextActions.join("\n")}
                    onChange={(event) =>
                      setValue({
                        ...value,
                        nextActions: event.target.value
                          .split("\n")
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              </fieldset>
              <button
                className={`${button} mt-3`}
                disabled={busy}
                type="button"
                onClick={() => void save()}
              >
                {t(acceptedRequest ? "sameRequest" : "save")}
              </button>
            </ConfirmDialog>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
