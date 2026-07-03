"use client";

import type { ExperimentComparisonDTO } from "@/lib/experiments/comparison";
import type { ExperimentHumanVerdict } from "@/lib/experiments/types";
import type { ReactElement } from "react";

import Link from "next/link";
import { useState, useTransition } from "react";

export interface VerdictPanelLabels {
  title: string;
  readOnly: string;
  viewerReadOnly: string;
  outcome: string;
  outcomeWinner: string;
  outcomeTie: string;
  outcomeInconclusive: string;
  winner: string;
  comment: string;
  abandonLosers: string;
  submit: string;
  score: string;
  skipOptional: string;
  optional: string;
  required: string;
  validationError: string;
  advisory: string;
  confidence: string;
  noAdvisory: string;
}

export interface JudgePanelLabels {
  title: string;
  ask: string;
  pending: string;
  unavailable: string;
  done: string;
  settings: string;
}

function isTerminal(status: ExperimentComparisonDTO["experiment"]["status"]): boolean {
  return status === "concluded" || status === "abandoned";
}

function scoreName(criterionId: string, variantKey: string): string {
  return `score.${criterionId}.${variantKey}`;
}

function parseScores(
  form: FormData,
  comparison: ExperimentComparisonDTO,
): Record<string, Record<string, number>> {
  const scores: Record<string, Record<string, number>> = {};

  for (const criterion of comparison.experiment.rubric.criteria) {
    for (const variant of comparison.variants) {
      const raw = form.get(scoreName(criterion.id, variant.key));

      if (typeof raw !== "string" || raw.length === 0) continue;

      scores[criterion.id] = {
        ...(scores[criterion.id] ?? {}),
        [variant.key]: Number(raw),
      };
    }
  }

  return scores;
}

function latestAdvisory(comparison: ExperimentComparisonDTO) {
  const advisories =
    comparison.verdict?.judgeAdvisories ??
    comparison.experiment.verdict?.judgeAdvisories ??
    [];

  return advisories.sort(
    (left, right) => right.advisoryOrdinal - left.advisoryOrdinal,
  )[0];
}

function humanVerdict(comparison: ExperimentComparisonDTO) {
  return comparison.verdict?.human ?? comparison.experiment.verdict?.human;
}

export function VerdictPanel({
  comparison,
  labels,
  canConclude,
  projectSlug,
}: {
  comparison: ExperimentComparisonDTO;
  labels: VerdictPanelLabels;
  canConclude: boolean;
  projectSlug: string;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const human = humanVerdict(comparison);
  const terminal = isTerminal(comparison.experiment.status);
  const readOnly = terminal || !canConclude;
  const advisory = latestAdvisory(comparison);

  async function submit(formEl: HTMLFormElement): Promise<void> {
    const form = new FormData(formEl);
    const outcome = String(form.get("outcome")) as ExperimentHumanVerdict["outcome"];
    const winnerVariantKey =
      outcome === "winner" ? String(form.get("winnerVariantKey")) : undefined;
    const skippedOptionalCriteria = comparison.experiment.rubric.criteria
      .filter(
        (criterion) =>
          criterion.optional && form.get(`skip.${criterion.id}`) === "on",
      )
      .map((criterion) => criterion.id);

    setError(null);

    const res = await fetch(
      `/api/projects/${projectSlug}/experiments/${comparison.experiment.id}/conclude`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome,
          winnerVariantKey,
          comment: String(form.get("comment") ?? ""),
          scores: parseScores(form, comparison),
          skippedOptionalCriteria,
          abandonLosers: form.get("abandonLosers") === "on",
        }),
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setError(body?.message ?? body?.code ?? labels.validationError);
      return;
    }

    startTransition(() => window.location.reload());
  }

  return (
    <section className="rounded-[12px] border border-line bg-paper p-4">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-base font-bold text-ink">{labels.title}</h2>
        {readOnly ? (
          <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            {terminal ? labels.readOnly : labels.viewerReadOnly}
          </span>
        ) : null}
      </header>
      {human ? (
        <div className="mb-4 rounded-[10px] border border-amber-line bg-amber-soft p-3 text-sm text-amber">
          <p className="m-0 font-semibold">
            {human.outcome === "winner"
              ? `${labels.outcomeWinner}: ${human.winnerVariantKey ?? "-"}`
              : human.outcome === "tie"
                ? labels.outcomeTie
                : labels.outcomeInconclusive}
          </p>
          {human.comment ? <p className="m-0 mt-1">{human.comment}</p> : null}
        </div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (readOnly) return;
          void submit(event.currentTarget);
        }}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.outcome}
            </span>
            <select
              className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink"
              disabled={readOnly}
              name="outcome"
            >
              <option value="winner">{labels.outcomeWinner}</option>
              <option value="tie">{labels.outcomeTie}</option>
              <option value="inconclusive">{labels.outcomeInconclusive}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
              {labels.winner}
            </span>
            <select
              className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink"
              disabled={readOnly}
              name="winnerVariantKey"
            >
              {comparison.variants.map((variant) => (
                <option key={variant.key} value={variant.key}>
                  {variant.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2 font-mono text-[11px] text-ink">
            <input disabled={readOnly} name="abandonLosers" type="checkbox" />
            {labels.abandonLosers}
          </label>
        </div>
        <div className="mt-4 overflow-hidden rounded-[10px] border border-line">
          {comparison.experiment.rubric.criteria.map((criterion) => (
            <div
              key={criterion.id}
              className="border-b border-line p-3 last:border-0"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="m-0 text-sm font-semibold text-ink">
                    {criterion.label}
                  </p>
                  <p className="m-0 mt-1 text-[12px] text-mute">
                    {criterion.guidance}
                  </p>
                </div>
                <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                  {criterion.optional ? labels.optional : labels.required}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {comparison.variants.map((variant) => (
                  <label key={variant.key} className="flex flex-col gap-1">
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                      {labels.score} · {variant.label}
                    </span>
                    <input
                      className="rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink"
                      disabled={readOnly}
                      max={criterion.scale.max}
                      min={criterion.scale.min}
                      name={scoreName(criterion.id, variant.key)}
                      type="number"
                    />
                  </label>
                ))}
              </div>
              {criterion.optional ? (
                <label className="mt-2 flex items-center gap-2 font-mono text-[11px] text-mute">
                  <input
                    disabled={readOnly}
                    name={`skip.${criterion.id}`}
                    type="checkbox"
                  />
                  {labels.skipOptional}
                </label>
              ) : null}
            </div>
          ))}
        </div>
        {advisory ? (
          <aside className="mt-4 rounded-[10px] border border-line bg-ivory p-3">
            <h3 className="m-0 mb-2 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-mute">
              {labels.advisory}
            </h3>
            <p className="m-0 text-sm text-ink">{advisory.summary}</p>
            {advisory.confidence !== undefined ? (
              <p className="m-0 mt-1 font-mono text-[11px] text-mute">
                {labels.confidence}: {advisory.confidence}
              </p>
            ) : null}
            {Object.entries(advisory.scores).map(([criterionId, byVariant]) => (
              <p
                key={criterionId}
                className="m-0 mt-1 font-mono text-[11px] text-mute"
              >
                {criterionId}:{" "}
                {Object.entries(byVariant)
                  .map(([variantKey, score]) => `${variantKey}: ${score}`)
                  .join(", ")}
              </p>
            ))}
          </aside>
        ) : (
          <p className="m-0 mt-4 text-sm text-mute">{labels.noAdvisory}</p>
        )}
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
            {labels.comment}
          </span>
          <textarea
            className="min-h-[80px] rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink"
            disabled={readOnly}
            name="comment"
          />
        </label>
        {error ? (
          <div
            className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        {!readOnly ? (
          <button
            className="mt-4 rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white"
            data-testid="verdict-submit"
            disabled={pending}
            type="submit"
          >
            {labels.submit}
          </button>
        ) : null}
      </form>
    </section>
  );
}

export function JudgePanel({
  labels,
  projectSlug,
  experimentId,
  available,
  pending,
  latestSummary,
}: {
  labels: JudgePanelLabels;
  projectSlug: string;
  experimentId: string;
  available: boolean;
  pending: boolean;
  latestSummary: string | null;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function askJudge(): Promise<void> {
    setBusy(true);
    setError(null);

    const res = await fetch(
      `/api/projects/${projectSlug}/experiments/${experimentId}/judge`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { message?: string; code?: string }
        | null;

      setError(body?.message ?? body?.code ?? labels.unavailable);
    }

    setBusy(false);
  }

  return (
    <section className="rounded-[12px] border border-line bg-paper p-4">
      <h2 className="m-0 text-base font-bold text-ink">{labels.title}</h2>
      {!available ? (
        <p className="m-0 mt-2 text-sm text-mute">
          {labels.unavailable}{" "}
          <Link className="text-amber" href={`/projects/${projectSlug}?tab=agents`}>
            {labels.settings}
          </Link>
        </p>
      ) : pending ? (
        <p className="m-0 mt-2 text-sm text-mute">{labels.pending}</p>
      ) : (
        <button
          className="mt-3 rounded-lg border border-line bg-ivory px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink hover:border-amber"
          disabled={busy}
          type="button"
          onClick={() => void askJudge()}
        >
          {labels.ask}
        </button>
      )}
      {latestSummary ? (
        <div className="mt-3 rounded-[10px] border border-line bg-ivory p-3">
          <p className="m-0 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-mute">
            {labels.done}
          </p>
          <p className="m-0 mt-1 text-sm text-ink">{latestSummary}</p>
        </div>
      ) : null}
      {error ? (
        <div
          className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}
