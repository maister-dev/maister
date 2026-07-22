"use client";

import type { ReactElement } from "react";

import { PlayIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { evalErrorKey, evalRequest } from "@/components/evaluations/api-error";
import {
  ControlledLaunch,
  type ControlledLaunchContext,
} from "@/components/evaluations/controlled-launch";
import {
  PairwiseScoreboard,
  type PairwiseTournamentView,
} from "@/components/evaluations/pairwise-scoreboard";
import { StandardizationPanel } from "@/components/evaluations/standardization-panel";
import { useStudyStream } from "@/components/evaluations/use-study-stream";
import { RunStreamLiveness } from "@/components/feedback/run-stream-liveness";
import { RUN_STATUS_KEYS } from "@/lib/runs/run-status-tone";

export interface ParticipantView {
  id: string;
  label: string;
  sourceType: "observed" | "launched";
  runId: string | null;
  runStatus: string | null;
}

export interface ExecutionView {
  id: string;
  status: string;
  terminalReason: string | null;
  methodQualifiedId: string | null;
  aggregate: {
    displayTotal: number | null;
    perCriterion: Array<{ criterionId: string; displayValue: number | null }>;
    warnings: string[] | null;
  } | null;
  // Pairwise tournament result (ADR-147), null for scalar methods.
  tournament: PairwiseTournamentView | null;
}

export interface VerdictView {
  id: string;
  outcome: string;
  createdAt: string | null;
}

type Props = {
  slug: string;
  study: { id: string; title: string; status: string; version: number };
  participants: ParticipantView[];
  executions: ExecutionView[];
  profiles: { id: string; name: string }[];
  comparableRuns: { id: string; status: string }[];
  verdicts: VerdictView[];
  controlledLaunch: ControlledLaunchContext;
  canManage: boolean;
  canConclude: boolean;
  canStandardize: boolean;
};

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);
const ACTIVE = new Set([
  "queued",
  "capturing",
  "checking",
  "judging",
  "aggregating",
  "review_required",
  "cancelling",
]);

type VerdictOutcome = "winner" | "tie" | "inconclusive";

// The comparability warnings of the CITED partial executions (deduped). A
// non-empty citation of a partial execution requires the operator to
// acknowledge these before the verdict route accepts the write.
export function citedPartialWarnings(
  executions: readonly ExecutionView[],
  citedIds: ReadonlySet<string>,
): { hasCitedPartial: boolean; warnings: string[] } {
  const citedPartials = executions.filter(
    (e) => citedIds.has(e.id) && e.status === "partial",
  );
  const warnings = [
    ...new Set(citedPartials.flatMap((e) => e.aggregate?.warnings ?? [])),
  ];

  return { hasCitedPartial: citedPartials.length > 0, warnings };
}

// The POST /verdicts body. `acknowledgedWarnings` must be non-empty whenever a
// partial execution is cited (server contract), so an empty warning list still
// records the acknowledged fact; a winner names its participant(s).
export function buildVerdictPayload(args: {
  outcome: VerdictOutcome;
  executions: readonly ExecutionView[];
  citedIds: ReadonlySet<string>;
  winnerId: string;
  zeroCitationAck: boolean;
  rationale: string;
}): {
  outcome: VerdictOutcome;
  participantIds: string[];
  executionIds: string[];
  noEvaluationEvidenceAck: boolean | undefined;
  acknowledgedWarnings: string[] | undefined;
  rationale: string | null;
} {
  const { hasCitedPartial, warnings } = citedPartialWarnings(
    args.executions,
    args.citedIds,
  );

  return {
    outcome: args.outcome,
    participantIds: args.outcome === "winner" ? [args.winnerId] : [],
    executionIds: [...args.citedIds],
    noEvaluationEvidenceAck:
      args.citedIds.size === 0 ? args.zeroCitationAck : undefined,
    acknowledgedWarnings: hasCitedPartial
      ? warnings.length > 0
        ? warnings
        : ["partial"]
      : undefined,
    rationale: args.rationale.trim() || null,
  };
}

function runStatusLabel(
  tRun: (key: string) => string,
  status: string | null,
): string {
  if (!status) return "—";

  return (RUN_STATUS_KEYS as readonly string[]).includes(status)
    ? tRun(`runStatus.${status}`)
    : status;
}

export function StudyLab({
  slug,
  study,
  participants,
  executions,
  profiles,
  comparableRuns,
  verdicts,
  controlledLaunch,
  canManage,
  canConclude,
  canStandardize,
}: Props): ReactElement {
  const t = useTranslations("evaluationsLab");
  const tErr = useTranslations("evaluationsErrors");
  const tRun = useTranslations("run");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());

  // Live SSE: the durable event log drives a debounced RSC refresh so the
  // scoreboard reflects each transition. No persisted state is mutated here
  // (read model only, D17); reconnect resumes via `?lastEventId=`.
  const hasActive = executions.some((e) => ACTIVE.has(e.status));
  const scheduleRefresh = useCallback((): void => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(
      () => startTransition(() => router.refresh()),
      400,
    );
  }, [router]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const { liveness, reconnect } = useStudyStream({
    slug,
    studyId: study.id,
    active: hasActive,
    onEvent: scheduleRefresh,
  });

  async function addObserved(): Promise<void> {
    setBusy("add");
    setError(null);
    try {
      await evalRequest(
        `/api/projects/${slug}/evaluations/studies/${study.id}/participants`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runIds: [...selectedRuns] }),
        },
      );
      setSelectedRuns(new Set());
      refresh();
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setBusy(null);
    }
  }

  async function startEvaluation(): Promise<void> {
    setBusy("start");
    setError(null);
    try {
      await evalRequest(
        `/api/projects/${slug}/evaluations/studies/${study.id}/evaluations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profileId }),
        },
      );
      refresh();
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setBusy(null);
    }
  }

  const alreadyParticipant = new Set(
    participants.filter((p) => p.runId).map((p) => p.runId as string),
  );
  const addableRuns = comparableRuns.filter(
    (r) => !alreadyParticipant.has(r.id),
  );
  const readyToLaunch = participants.length >= 2 && profiles.length > 0;
  const labelFor = (id: string): string =>
    participants.find((p) => p.id === id)?.label ?? id.slice(0, 8);

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-[20px] font-semibold text-ink">
            {study.title}
          </h1>
          <span className="mt-1 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-mute">
            {t(`status_${study.status}`)}
            {hasActive ? (
              <RunStreamLiveness
                labels={{
                  disconnected: tRun("streamDisconnected"),
                  live: tRun("streamLive"),
                  reconnect: tRun("streamReconnect"),
                  reconnecting: tRun("streamReconnecting"),
                }}
                liveness={liveness}
                onReconnect={reconnect}
              />
            ) : (
              <span aria-live="polite" className="text-mute">
                {t("idle")}
              </span>
            )}
          </span>
        </div>
      </div>

      {error ? (
        <p className="mb-3 text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <section className="mb-6">
        <h2 className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("participants")} ({participants.length})
        </h2>
        {participants.length === 0 ? (
          <p className="text-[13px] text-mute">{t("noParticipants")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left">
              <thead className="border-b border-line bg-ivory">
                <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                  <th className="px-3 py-2">{t("colParticipant")}</th>
                  <th className="px-3 py-2">{t("colSource")}</th>
                  <th className="px-3 py-2">{t("colRunStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {participants.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-line text-[12px] last:border-b-0"
                  >
                    <td className="px-3 py-2 font-semibold text-ink">
                      {p.label}
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {t(`source_${p.sourceType}`)}
                    </td>
                    <td className="px-3 py-2 font-mono text-ink-2">
                      {runStatusLabel(tRun, p.runStatus)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canManage && addableRuns.length > 0 ? (
          <details className="mt-3 rounded-[8px] border border-line bg-paper p-3">
            <summary className="cursor-pointer text-[12px] font-semibold text-ink">
              {t("addObserved")}
            </summary>
            <ul className="mt-2 grid list-none gap-1 p-0">
              {addableRuns.map((run) => (
                <li key={run.id}>
                  <label className="flex items-center gap-2 text-[12px] text-ink">
                    <input
                      checked={selectedRuns.has(run.id)}
                      type="checkbox"
                      onChange={(e) =>
                        setSelectedRuns((prev) => {
                          const next = new Set(prev);

                          if (e.target.checked) next.add(run.id);
                          else next.delete(run.id);

                          return next;
                        })
                      }
                    />
                    <span className="font-mono text-[11px] text-mute">
                      {run.id.slice(0, 8)}
                    </span>
                    <span className="text-ink-2">
                      {runStatusLabel(tRun, run.status)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <button
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
              disabled={busy !== null || selectedRuns.size === 0}
              type="button"
              onClick={() => void addObserved()}
            >
              <PlusIcon aria-hidden="true" className="h-4 w-4" />
              {t("addSelected")}
            </button>
          </details>
        ) : null}
      </section>

      {canManage ? (
        <ControlledLaunch
          context={controlledLaunch}
          slug={slug}
          studyId={study.id}
        />
      ) : null}

      {canManage ? (
        <section className="mb-6 flex flex-wrap items-end gap-3 rounded-[10px] border border-line bg-paper p-4">
          <label className="flex flex-1 flex-col gap-1">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
              {t("profile")}
            </span>
            <select
              className="h-10 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.length === 0 ? (
                <option value="">{t("noProfiles")}</option>
              ) : null}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="inline-flex h-10 items-center gap-1.5 rounded-[8px] border border-line bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
            disabled={busy !== null || !readyToLaunch || !profileId}
            title={!readyToLaunch ? t("launchNeedsTwo") : undefined}
            type="button"
            onClick={() => void startEvaluation()}
          >
            <PlayIcon aria-hidden="true" className="h-4 w-4" />
            {t("startEvaluation")}
          </button>
        </section>
      ) : null}

      <section className="mb-6">
        <h2 className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("evaluations")} ({executions.length})
        </h2>
        {executions.length === 0 ? (
          <p className="text-[13px] text-mute">{t("noEvaluations")}</p>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {executions.map((exec) => (
              <li
                key={exec.id}
                className="rounded-[10px] border border-line bg-paper p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12px] text-ink-2">
                    {exec.methodQualifiedId ?? t("legacyMethod")}
                  </span>
                  <span
                    className={`font-mono text-[11px] uppercase tracking-[0.08em] ${
                      exec.status === "completed"
                        ? "text-good"
                        : exec.status === "failed"
                          ? "text-danger"
                          : TERMINAL.has(exec.status)
                            ? "text-ink-2"
                            : "text-amber"
                    }`}
                  >
                    {t(`exec_${exec.status}`)}
                  </span>
                </div>
                {TERMINAL.has(exec.status) && exec.terminalReason ? (
                  <p className="mt-1 text-[11px] text-danger">
                    {t("terminalReason")}:{" "}
                    <span className="font-mono">{exec.terminalReason}</span>
                  </p>
                ) : null}
                {exec.tournament ? (
                  <PairwiseScoreboard
                    labelFor={labelFor}
                    tournament={exec.tournament}
                  />
                ) : exec.aggregate ? (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
                    <span className="font-semibold text-ink">
                      {t("total")}:{" "}
                      {exec.aggregate.displayTotal ?? t("insufficient")}
                    </span>
                    {exec.aggregate.perCriterion.map((c) => (
                      <span key={c.criterionId} className="text-ink-2">
                        {c.criterionId}: {c.displayValue ?? "—"}
                      </span>
                    ))}
                    {exec.aggregate.warnings &&
                    exec.aggregate.warnings.length > 0 ? (
                      <span className="text-attention">
                        ⚠ {exec.aggregate.warnings.length}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <VerdictPanel
        canConclude={canConclude}
        executions={executions}
        participants={participants}
        slug={slug}
        studyId={study.id}
        studyStatus={study.status}
        verdicts={verdicts}
      />

      {canStandardize ? (
        <StandardizationPanel slug={slug} studyId={study.id} />
      ) : null}
    </div>
  );
}

function VerdictPanel({
  slug,
  studyId,
  studyStatus,
  executions,
  participants,
  verdicts,
  canConclude,
}: {
  slug: string;
  studyId: string;
  studyStatus: string;
  executions: ExecutionView[];
  participants: ParticipantView[];
  verdicts: VerdictView[];
  canConclude: boolean;
}): ReactElement {
  const t = useTranslations("evaluationsLab");
  const tErr = useTranslations("evaluationsErrors");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<VerdictOutcome>("winner");
  const [winnerId, setWinnerId] = useState("");
  const [cited, setCited] = useState<Set<string>>(new Set());
  const [rationale, setRationale] = useState("");
  const [ack, setAck] = useState(false);
  const [partialAck, setPartialAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const citable = executions.filter((e) =>
    ["completed", "partial"].includes(e.status),
  );
  const { hasCitedPartial, warnings: partialWarnings } = citedPartialWarnings(
    executions,
    cited,
  );
  const winnerMissing = outcome === "winner" && winnerId === "";

  async function record(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await evalRequest(
        `/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            buildVerdictPayload({
              outcome,
              executions,
              citedIds: cited,
              winnerId,
              zeroCitationAck: ack,
              rationale,
            }),
          ),
        },
      );
      startTransition(() => router.refresh());
    } catch (err) {
      setError(tErr(evalErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[10px] border border-line bg-paper p-4">
      <h2 className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {t("humanVerdict")}
      </h2>

      {verdicts.length > 0 ? (
        <ul className="mb-3 grid list-none gap-1 p-0">
          {verdicts.map((v) => (
            <li key={v.id} className="text-[12px] text-ink-2">
              ✓ {t(`outcome_${v.outcome}`)}
            </li>
          ))}
        </ul>
      ) : null}

      {canConclude && studyStatus !== "archived" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label={t("outcome")}
              className="h-9 rounded-[8px] border border-line bg-paper px-3 text-[13px] text-ink outline-none"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as VerdictOutcome)}
            >
              <option value="winner">{t("outcome_winner")}</option>
              <option value="tie">{t("outcome_tie")}</option>
              <option value="inconclusive">{t("outcome_inconclusive")}</option>
            </select>
          </div>

          {outcome === "winner" ? (
            <fieldset className="border-0 p-0">
              <legend className="mb-1 text-[11px] text-mute">
                {t("winnerParticipant")}
              </legend>
              {participants.length === 0 ? (
                <p className="text-[12px] text-mute">{t("noParticipants")}</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {participants.map((p) => (
                    <label
                      key={p.id}
                      className="flex items-center gap-2 text-[12px] text-ink"
                    >
                      <input
                        checked={winnerId === p.id}
                        name="verdict-winner"
                        type="radio"
                        value={p.id}
                        onChange={() => setWinnerId(p.id)}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          ) : null}

          {citable.length > 0 ? (
            <fieldset className="border-0 p-0">
              <legend className="mb-1 text-[11px] text-mute">
                {t("citeExecutions")}
              </legend>
              <div className="flex flex-col gap-1">
                {citable.map((e) => (
                  <label
                    key={e.id}
                    className="flex items-center gap-2 text-[12px] text-ink"
                  >
                    <input
                      checked={cited.has(e.id)}
                      type="checkbox"
                      onChange={(ev) =>
                        setCited((prev) => {
                          const next = new Set(prev);

                          if (ev.target.checked) next.add(e.id);
                          else next.delete(e.id);

                          return next;
                        })
                      }
                    />
                    <span className="font-mono text-[11px] text-mute">
                      {e.id.slice(0, 8)}
                    </span>
                    <span className="text-ink-2">{t(`exec_${e.status}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {hasCitedPartial ? (
            <div className="rounded-[8px] border border-line bg-ivory p-3">
              {partialWarnings.length > 0 ? (
                <ul
                  aria-label={t("partialCitedWarnings")}
                  className="m-0 mb-2 grid list-none gap-1 p-0"
                >
                  {partialWarnings.map((warning) => (
                    <li
                      key={warning}
                      className="font-mono text-[11px] text-attention"
                    >
                      ⚠ {warning}
                    </li>
                  ))}
                </ul>
              ) : null}
              <label className="flex items-center gap-2 text-[12px] text-ink">
                <input
                  checked={partialAck}
                  type="checkbox"
                  onChange={(e) => setPartialAck(e.target.checked)}
                />
                {t("partialAck")}
              </label>
            </div>
          ) : null}

          {cited.size === 0 ? (
            <label className="flex items-center gap-2 text-[12px] text-ink">
              <input
                checked={ack}
                type="checkbox"
                onChange={(e) => setAck(e.target.checked)}
              />
              {t("zeroCitationAck")}
            </label>
          ) : null}

          <textarea
            className="min-h-[56px] rounded-[8px] border border-line bg-paper px-3 py-2 text-[13px] text-ink outline-none"
            placeholder={t("rationale")}
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
          />

          {error ? (
            <p className="text-[12px] text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <button
            className="inline-flex h-10 w-fit items-center gap-1.5 rounded-[8px] border border-line bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
            disabled={
              busy ||
              winnerMissing ||
              (cited.size === 0 && !ack) ||
              (hasCitedPartial && !partialAck)
            }
            title={winnerMissing ? t("winnerRequiredHint") : undefined}
            type="button"
            onClick={() => void record()}
          >
            {t("recordVerdict")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
