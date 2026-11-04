"use client";

import type { ReactElement } from "react";
import type {
  HumanAssessmentDraft,
  HumanAssessmentEvidence,
  HumanAssessmentIssue,
  HumanAssessmentWrite,
} from "@/lib/tasks/human-assessment-schema";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";
import { QUALIFICATION_DIMENSIONS } from "@/lib/tasks/qualification-types";
import {
  humanAssessmentWriteSchema,
  humanAssessmentIssues,
} from "@/lib/tasks/human-assessment-schema";

const button =
  "inline-flex min-h-8 items-center rounded-lg border border-line bg-ivory px-3 text-xs font-semibold text-ink disabled:opacity-50";
const field =
  "mt-1 block w-full rounded-lg border border-line bg-paper p-2 text-sm";

type SelectedEvidence = Readonly<{
  selector: HumanAssessmentEvidence;
  label: string;
}>;
type FormValue = Pick<
  HumanAssessmentWrite,
  "requestType" | "decision" | "checks" | "nextActions"
>;
type Tree = Readonly<{
  path: string;
  entries: ReadonlyArray<Readonly<{ name: string; type: "file" | "dir" }>>;
}>;

function initialValue(): FormValue {
  return {
    requestType: "feature",
    decision: "needs_review",
    checks: QUALIFICATION_DIMENSIONS.map((dimension) => ({
      dimension,
      state: "unknown",
      rationale: "",
      evidenceIndexes: [],
    })),
    nextActions: [],
  };
}

/** Optional authoring uses selectors and server provenance; it never grants execution. */
export function HumanAssessmentForm({
  endpoint,
  slug,
  initialDraft,
  open = true,
  onClose,
  onSaved,
}: {
  endpoint: string;
  slug: string;
  initialDraft: HumanAssessmentDraft;
  open?: boolean;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const t = useTranslations("taskQualification");
  const [draft, setDraft] = useState(initialDraft);
  const [value, setValue] = useState<FormValue>(initialValue);
  const [selected, setSelected] = useState<SelectedEvidence[]>([]);
  const [repository, setRepository] =
    useState<HumanAssessmentDraft["repository"]>();
  const [tree, setTree] = useState<Tree | null>(null);
  const [search, setSearch] = useState("");
  const [taskChoice, setTaskChoice] = useState("");
  const [runChoice, setRunChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<HumanAssessmentWrite | null>(null);
  const [issues, setIssues] = useState<HumanAssessmentIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fieldsRef = useRef<HTMLFieldSetElement>(null);
  const issuesRef = useRef<HTMLUListElement>(null);
  const frozen = busy || submitted !== null;

  useEffect(() => {
    if (!open || issues.length === 0) return;
    const invalid = fieldsRef.current?.querySelector<HTMLElement>(
      'input[aria-invalid="true"],select[aria-invalid="true"],textarea[aria-invalid="true"]',
    );

    (invalid ?? issuesRef.current)?.focus();
  }, [issues, open]);

  function addEvidence(item: SelectedEvidence): void {
    if (
      selected.some(
        (entry) =>
          JSON.stringify(entry.selector) === JSON.stringify(item.selector),
      )
    )
      return;
    setSelected([...selected, item]);
  }

  function removeEvidence(index: number): void {
    setSelected(selected.filter((_, position) => position !== index));
    setValue({
      ...value,
      checks: value.checks.map((check) => ({
        ...check,
        evidenceIndexes: check.evidenceIndexes
          .filter((position) => position !== index)
          .map((position) => (position > index ? position - 1 : position)),
      })),
    });
  }

  async function loadChoices(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${endpoint}?${new URLSearchParams({ search })}`,
      );

      if (!response.ok) {
        setError(t("loadError"));

        return;
      }
      const next = (await response.json()) as HumanAssessmentDraft;

      if (next.contextToken !== draft.contextToken) {
        setError(t("conflict"));

        return;
      }
      setDraft(next);
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  }

  async function browse(path = ""): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      let current = repository;

      if (!current) {
        const response = await fetch(`${endpoint}?repository=1`);

        if (!response.ok) {
          setError(t(response.status === 403 ? "permission" : "loadError"));

          return;
        }
        const next = (await response.json()) as HumanAssessmentDraft;

        if (next.contextToken !== draft.contextToken || !next.repository) {
          setError(t("conflict"));

          return;
        }
        current = next.repository;
        setRepository(current);
      }
      const response = await fetch(
        `/api/projects/${slug}/files?${new URLSearchParams({ ref: current.ref, path })}`,
      );

      if (!response.ok) {
        setError(t(response.status === 403 ? "permission" : "loadError"));

        return;
      }
      setTree((await response.json()) as Tree);
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  }

  async function refresh(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint);

      if (!response.ok) {
        setError(t("loadError"));

        return;
      }
      setDraft((await response.json()) as HumanAssessmentDraft);
      setValue(initialValue());
      setSelected([]);
      setRepository(undefined);
      setTree(null);
      setIssues([]);
    } catch {
      setError(t("loadError"));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    const parsed = humanAssessmentWriteSchema.safeParse(
      submitted ?? {
        ...value,
        requestKey: crypto.randomUUID(),
        contextToken: draft.contextToken,
        expectedInputRevision: draft.expectedInputRevision,
        expectedQualificationRevision: draft.expectedQualificationRevision,
        repositoryToken: repository?.token ?? null,
        evidence: selected.map((item) => item.selector),
      },
    );

    if (!parsed.success) {
      setIssues(humanAssessmentIssues(parsed.error));

      return;
    }
    setSubmitted(parsed.data);
    setIssues([]);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (!response.ok) {
        const failure = (await response.json()) as {
          issues?: HumanAssessmentIssue[];
        };

        setIssues(failure.issues ?? []);
        setError(
          t(
            response.status === 409
              ? "conflict"
              : response.status === 403
                ? "permission"
                : response.status >= 500
                  ? "unknownWrite"
                  : "saveError",
          ),
        );
        if (response.status < 500) setSubmitted(null);

        return;
      }
      onSaved();
    } catch {
      setError(t("unknownWrite"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <></>;

  return (
    <ConfirmDialog
      body={t("humanHint")}
      busy={busy}
      cancelLabel={t("close")}
      testId="task-qualification-dialog"
      title={t("humanAssessment")}
      titleId="human-assessment-title"
      onClose={onClose}
    >
      {error ? <p role="alert">{error}</p> : null}
      {issues.length ? (
        <ul
          ref={issuesRef}
          className="my-3 list-disc pl-5 text-sm text-red-700"
          id="human-assessment-errors"
          role="alert"
          tabIndex={-1}
        >
          {issues.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>
              {t(`authoring.validation.${issue.key}`)}{" "}
              {issue.path.startsWith("checks.")
                ? t(
                    `dimension.${value.checks[Number(issue.path.split(".")[1])]?.dimension ?? "goal_scope"}`,
                  )
                : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="my-3 text-sm text-mute">{t("authoring.optional")}</p>
      <fieldset ref={fieldsRef} className="space-y-3" disabled={frozen}>
        <label className="block text-sm">
          {t("requestType")}
          <select
            className={field}
            value={value.requestType}
            onChange={(event) =>
              setValue({
                ...value,
                requestType: event.target.value as FormValue["requestType"],
              })
            }
          >
            {["bug", "feature", "maintenance", "question"].map((type) => (
              <option key={type} value={type}>
                {t(`type.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          {t("decisionLabel")}
          <select
            aria-describedby={
              issues.some((issue) => issue.path === "decision")
                ? "human-assessment-errors"
                : undefined
            }
            aria-invalid={issues.some((issue) => issue.path === "decision")}
            className={field}
            value={value.decision}
            onChange={(event) =>
              setValue({
                ...value,
                decision: event.target.value as FormValue["decision"],
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
        <section
          aria-label={t("authoring.evidenceTitle")}
          className="space-y-2 rounded-lg border border-line p-3"
        >
          <h3 className="font-semibold">{t("authoring.evidenceTitle")}</h3>
          <p className="text-xs text-mute">{t("authoring.evidenceHint")}</p>
          <label className="block text-sm">
            {t("authoring.search")}
            <input
              className={field}
              maxLength={100}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button
            className={button}
            type="button"
            onClick={() => void loadChoices()}
          >
            {t("authoring.find")}
          </button>
          <label className="block text-sm">
            {t("authoring.task")}
            <select
              className={field}
              value={taskChoice}
              onChange={(event) => setTaskChoice(event.target.value)}
            >
              <option value="">{t("authoring.choose")}</option>
              {draft.tasks.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className={button}
            disabled={!taskChoice || selected.length >= 32}
            type="button"
            onClick={() => {
              const item = draft.tasks.find((entry) => entry.id === taskChoice);

              if (item)
                addEvidence({
                  selector: { kind: "task", taskId: item.id },
                  label: item.label,
                });
            }}
          >
            {t("authoring.addTask")}
          </button>
          <label className="block text-sm">
            {t("authoring.run")}
            <select
              className={field}
              value={runChoice}
              onChange={(event) => setRunChoice(event.target.value)}
            >
              <option value="">{t("authoring.choose")}</option>
              {draft.runs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className={button}
            disabled={!runChoice || selected.length >= 32}
            type="button"
            onClick={() => {
              const item = draft.runs.find((entry) => entry.id === runChoice);

              if (item)
                addEvidence({
                  selector: { kind: "run", runId: item.id },
                  label: item.label,
                });
            }}
          >
            {t("authoring.addRun")}
          </button>
          <button
            className={button}
            type="button"
            onClick={() => void browse()}
          >
            {t("authoring.browseFiles")}
          </button>
          {tree ? (
            <div aria-label={t("authoring.files")}>
              <p className="break-all text-xs">{tree.path || "/"}</p>
              {tree.path ? (
                <button
                  className={button}
                  type="button"
                  onClick={() =>
                    void browse(tree.path.split("/").slice(0, -1).join("/"))
                  }
                >
                  {t("authoring.parentFolder")}
                </button>
              ) : null}
              <ul className="max-h-48 overflow-y-auto">
                {tree.entries.map((entry) => {
                  const path = tree.path
                    ? `${tree.path}/${entry.name}`
                    : entry.name;

                  return (
                    <li key={path}>
                      <button
                        className={button}
                        disabled={
                          entry.type === "file" &&
                          (path.length > 180 || selected.length >= 32)
                        }
                        type="button"
                        onClick={() =>
                          entry.type === "dir"
                            ? void browse(path)
                            : addEvidence({
                                selector: { kind: "file", path },
                                label: path,
                              })
                        }
                      >
                        {entry.type === "dir" ? "▸ " : "+ "}
                        {entry.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          <ul>
            {selected.map((item, index) => (
              <li
                key={JSON.stringify(item.selector)}
                className="flex items-center gap-2 text-sm"
              >
                <span className="break-all">{item.label}</span>
                <button
                  aria-label={t("authoring.removeEvidence", {
                    evidence: item.label,
                  })}
                  className={button}
                  type="button"
                  onClick={() => removeEvidence(index)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
        {value.checks.map((check, index) => (
          <fieldset
            key={check.dimension}
            aria-describedby={`human-check-${index}-help${issues.some((issue) => issue.path.startsWith(`checks.${index}.`)) ? " human-assessment-errors" : ""}`}
            className="space-y-2 rounded-lg border border-line p-3"
          >
            <legend className="px-1 text-sm font-semibold">
              {t(`dimension.${check.dimension}`)}
            </legend>
            <p className="text-xs text-mute" id={`human-check-${index}-help`}>
              {t(`authoring.explanation.${check.dimension}`)}
            </p>
            <label className="block text-sm">
              {t("checkLabel")}
              <select
                aria-invalid={issues.some(
                  (issue) => issue.path === `checks.${index}.state`,
                )}
                className={field}
                value={check.state}
                onChange={(event) =>
                  setValue({
                    ...value,
                    checks: value.checks.map((item, position) =>
                      position === index
                        ? {
                            ...item,
                            state: event.target.value as typeof check.state,
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
            <label className="block text-sm">
              {t("rationale")}
              <textarea
                aria-invalid={issues.some(
                  (issue) => issue.path === `checks.${index}.rationale`,
                )}
                className={field}
                maxLength={2000}
                value={check.rationale}
                onChange={(event) =>
                  setValue({
                    ...value,
                    checks: value.checks.map((item, position) =>
                      position === index
                        ? { ...item, rationale: event.target.value }
                        : item,
                    ),
                  })
                }
              />
            </label>
            <div className="text-xs">
              {t("authoring.linkEvidence")}
              {selected.map((item, evidenceIndex) => (
                <label
                  key={JSON.stringify(item.selector)}
                  className="mt-1 flex items-center gap-2"
                >
                  <input
                    checked={check.evidenceIndexes.includes(evidenceIndex)}
                    type="checkbox"
                    onChange={(event) =>
                      setValue({
                        ...value,
                        checks: value.checks.map((entry, position) =>
                          position === index
                            ? {
                                ...entry,
                                evidenceIndexes: event.target.checked
                                  ? [...entry.evidenceIndexes, evidenceIndex]
                                  : entry.evidenceIndexes.filter(
                                      (value) => value !== evidenceIndex,
                                    ),
                              }
                            : entry,
                        ),
                      })
                    }
                  />
                  <span className="break-all">{item.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <label className="block text-sm">
          {t("nextActions")}
          <textarea
            aria-invalid={issues.some(
              (issue) =>
                issue.path === "nextActions" ||
                issue.path.startsWith("nextActions."),
            )}
            className={field}
            value={value.nextActions.join("\n")}
            onChange={(event) =>
              setValue({
                ...value,
                nextActions: event.target.value.split("\n").filter(Boolean),
              })
            }
          />
        </label>
      </fieldset>
      <div className="mt-3 flex gap-2">
        <button
          className={button}
          disabled={busy}
          type="button"
          onClick={() => void save()}
        >
          {t(submitted ? "sameRequest" : "save")}
        </button>
        <button
          className={button}
          disabled={frozen}
          type="button"
          onClick={() => void refresh()}
        >
          {t("authoring.refresh")}
        </button>
      </div>
    </ConfirmDialog>
  );
}
