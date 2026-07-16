"use client";

import type { ReactElement } from "react";

import { PlayIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

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
  requestedAt: string | null;
  aggregate: {
    displayTotal: number | null;
    perCriterion: Array<{ criterionId: string; displayValue: number | null }>;
    warnings: string[] | null;
  } | null;
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
  canManage: boolean;
  canConclude: boolean;
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

export function StudyLab({
  slug,
  study,
  participants,
  executions,
  profiles,
  comparableRuns,
  verdicts,
  canManage,
  canConclude,
}: Props): ReactElement {
  const t = useTranslations("evaluationsLab");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [live, setLive] = useState<"connecting" | "live" | "closed">(
    "connecting",
  );
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());

  // Live SSE: the durable event log drives a debounced RSC refresh so the
  // scoreboard reflects each transition. No persisted state is mutated here
  // (read model only, D17); reconnect is EventSource's own Last-Event-ID.
  useEffect(() => {
    const hasActive = executions.some((e) => ACTIVE.has(e.status));

    if (!hasActive) {
      setLive("closed");

      return;
    }
    const url = `/api/projects/${slug}/evaluations/studies/${study.id}/stream`;
    const source = new EventSource(url);

    source.onopen = () => setLive("live");
    source.onmessage = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(refresh, 400);
    };
    source.onerror = () => setLive("connecting");

    return () => {
      source.close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [slug, study.id, executions]);

  async function post(url: string, body: unknown): Promise<void> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;

      throw new Error(payload?.message ?? `request failed: ${res.status}`);
    }
  }

  async function addObserved(): Promise<void> {
    setBusy("add");
    setError(null);
    try {
      await post(
        `/api/projects/${slug}/evaluations/studies/${study.id}/participants`,
        { runIds: [...selectedRuns] },
      );
      setSelectedRuns(new Set());
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startEvaluation(): Promise<void> {
    setBusy("start");
    setError(null);
    try {
      await post(
        `/api/projects/${slug}/evaluations/studies/${study.id}/evaluations`,
        { profileId },
      );
      setLive("connecting");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-[20px] font-semibold text-ink">
            {study.title}
          </h1>
          <span className="mt-1 inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-mute">
            {t(`status_${study.status}`)}
            <LivePill
              labels={{
                live: t("live"),
                connecting: t("connecting"),
                closed: t("idle"),
              }}
              live={live}
            />
          </span>
        </div>
      </div>

      {error ? (
        <p className="mb-3 text-[12px] text-red-700" role="alert">
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
                      {p.runStatus ?? "—"}
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
                    <span className="text-ink-2">{run.status}</span>
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
                          ? "text-attention"
                          : TERMINAL.has(exec.status)
                            ? "text-ink-2"
                            : "text-amber"
                    }`}
                  >
                    {t(`exec_${exec.status}`)}
                  </span>
                </div>
                {exec.aggregate ? (
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
        slug={slug}
        studyId={study.id}
        studyStatus={study.status}
        verdicts={verdicts}
      />
    </div>
  );
}

function LivePill({
  live,
  labels,
}: {
  live: "connecting" | "live" | "closed";
  labels: { live: string; connecting: string; closed: string };
}): ReactElement {
  const tone =
    live === "live"
      ? "text-good"
      : live === "connecting"
        ? "text-amber"
        : "text-mute";
  const dot =
    live === "live"
      ? "bg-good"
      : live === "connecting"
        ? "bg-amber"
        : "bg-mute";

  return (
    <span className={`inline-flex items-center gap-1 ${tone}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {labels[live]}
    </span>
  );
}

function VerdictPanel({
  slug,
  studyId,
  studyStatus,
  executions,
  verdicts,
  canConclude,
}: {
  slug: string;
  studyId: string;
  studyStatus: string;
  executions: ExecutionView[];
  verdicts: VerdictView[];
  canConclude: boolean;
}): ReactElement {
  const t = useTranslations("evaluationsLab");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<"winner" | "tie" | "inconclusive">(
    "winner",
  );
  const [cited, setCited] = useState<Set<string>>(new Set());
  const [rationale, setRationale] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const citable = executions.filter((e) =>
    ["completed", "partial"].includes(e.status),
  );

  async function record(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            outcome,
            participantIds: [],
            executionIds: [...cited],
            noEvaluationEvidenceAck: cited.size === 0 ? ack : undefined,
            rationale: rationale.trim() || null,
          }),
        },
      );

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;

        throw new Error(payload?.message ?? `request failed: ${res.status}`);
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
              onChange={(e) => setOutcome(e.target.value as typeof outcome)}
            >
              <option value="winner">{t("outcome_winner")}</option>
              <option value="tie">{t("outcome_tie")}</option>
              <option value="inconclusive">{t("outcome_inconclusive")}</option>
            </select>
          </div>

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
            <p className="text-[12px] text-red-700" role="alert">
              {error}
            </p>
          ) : null}

          <button
            className="inline-flex h-10 w-fit items-center gap-1.5 rounded-[8px] border border-line bg-ink px-4 text-[13px] font-semibold text-paper disabled:opacity-50"
            disabled={busy || (cited.size === 0 && !ack)}
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
