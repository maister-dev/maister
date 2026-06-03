"use client";

import type { ReadinessDTO } from "@/lib/queries/readiness";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import clsx from "clsx";

type PromotionMode = "local_merge" | "pull_request";

export type ReviewPanelConflict = {
  parentRepoPath: string;
  targetBranch: string;
  runBranch: string;
  command: string;
};

export type ReviewPanelLabels = {
  promoteTo: string;
  promotionMode: string;
  readinessReady: string;
  readinessBlocked: string;
  prLink: string;
  targetDrift: string;
  promoteAnyway: string;
};

export interface ReviewPanelProps {
  runId: string;
  baseBranch: string | null;
  baseCommit: string | null;
  runBranch: string;
  targetBranch: string | null;
  promotionMode: PromotionMode;
  reviewedTargetCommit: string | null;
  readiness: ReadinessDTO | null;
  diff: string;
  labels: ReviewPanelLabels;
  prUrl?: string | null;
  prNumber?: number | null;
  // The parent repo path, named in the conflict card so the operator can resolve
  // the merge by hand. Server-state; null on a pre-M18 row.
  parentRepoPath?: string | null;
  // A pre-M18 row whose branch metadata cannot be derived: the panel shows the
  // "relaunch to promote" PRECONDITION state instead of the Promote action.
  legacyNeedsRelaunch?: boolean;
  // Server-resolved drift (the live target HEAD moved since this render): the
  // panel opens directly in the drift state offering "Promote anyway".
  driftDetected?: boolean;
  // Server-detected merge conflict context (renders the manual-resolution card).
  conflict?: ReviewPanelConflict;
  // Whether the viewer may promote (= canAct). The review SURFACE (diff,
  // readiness, conflict context) is always visible; only the Promote action is
  // gated. The server `requireProjectAction(…,"promoteRun")` is the real
  // boundary — this is UI consistency / defense-in-depth.
  canPromote?: boolean;
}

const shell =
  "rounded-[14px] border border-line bg-[color-mix(in_oklab,var(--ivory)_35%,var(--paper))]";

export function ReviewPanel({
  runId,
  baseBranch,
  baseCommit,
  runBranch,
  targetBranch,
  promotionMode,
  reviewedTargetCommit,
  readiness,
  diff,
  labels,
  prUrl,
  prNumber,
  parentRepoPath,
  legacyNeedsRelaunch = false,
  driftDetected = false,
  conflict,
  canPromote = true,
}: ReviewPanelProps): ReactElement {
  const t = useTranslations("run");
  const router = useRouter();
  const [mode, setMode] = useState<PromotionMode>(promotionMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drift, setDrift] = useState(driftDetected);
  const [conflictState, setConflictState] =
    useState<ReviewPanelConflict | null>(conflict ?? null);

  async function promote(allowTargetDrift: boolean): Promise<void> {
    if (!targetBranch) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/runs/${runId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          targetBranch,
          // Omit when null (the render-time resolveBaseCommit threw): the route
          // rejects a null with CONFIG 400, but a MISSING field hits the
          // server's `!reviewedTargetCommit → PRECONDITION` path cleanly.
          ...(reviewedTargetCommit ? { reviewedTargetCommit } : {}),
          ...(allowTargetDrift ? { allowTargetDrift: true } : {}),
        }),
      });

      if (res.ok) {
        router.refresh();

        return;
      }

      const data = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      if (
        data?.code === "PRECONDITION" &&
        /target advanced/i.test(data.message ?? "")
      ) {
        setDrift(true);
        router.refresh();

        return;
      }

      if (data?.code === "CONFLICT") {
        setConflictState({
          parentRepoPath: parentRepoPath ?? "",
          targetBranch,
          runBranch,
          command: `git merge --no-ff ${runBranch}`,
        });

        return;
      }

      setError(data?.code ?? "CRASH");
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }

  const readinessReady = readiness?.readiness === "ready";

  return (
    <section className={clsx(shell, "mt-6 p-5")} data-testid="review-panel">
      <h2 className="mb-4 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-accent-4 before:content-['']">
        {t("reviewTitle")}
      </h2>

      {/* base → run → target spine */}
      <div className="mb-4 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-2">
        {baseBranch ? (
          <span
            className="rounded-md border border-line bg-paper px-2 py-1 font-semibold"
            data-testid="review-base-branch"
          >
            {baseBranch}
            {baseCommit ? (
              <span className="ml-1.5 text-mute">{baseCommit.slice(0, 7)}</span>
            ) : null}
          </span>
        ) : null}
        <span aria-hidden="true" className="text-mute">
          →
        </span>
        <span
          className="rounded-md border border-amber-line bg-amber-soft px-2 py-1 font-semibold text-amber"
          data-testid="review-run-branch"
        >
          {runBranch}
        </span>
        <span aria-hidden="true" className="text-mute">
          →
        </span>
        {targetBranch ? (
          <span
            className="rounded-md border border-[color-mix(in_oklab,var(--accent-4)_35%,var(--line))] bg-accent-4-soft px-2 py-1 font-semibold text-accent-4"
            data-testid="review-target-branch"
          >
            {targetBranch}
          </span>
        ) : null}
      </div>

      {/* readiness summary */}
      {readiness ? (
        <div className="mb-4" data-testid="review-readiness">
          <span
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-bold",
              readinessReady
                ? "border-[color-mix(in_oklab,var(--accent-4)_35%,var(--line))] bg-accent-4-soft text-accent-4"
                : "border-amber-line bg-amber-soft text-amber",
            )}
          >
            {readinessReady ? labels.readinessReady : labels.readinessBlocked}
          </span>
          {!readinessReady && readiness.reasons.length > 0 ? (
            <ul className="mt-2 flex list-none flex-col gap-1 p-0 font-mono text-[10.5px] text-mute">
              {readiness.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* raw diff */}
      <pre className="mb-4 max-h-[420px] overflow-auto rounded-lg border border-line-soft bg-paper p-4 font-mono text-[11px] leading-[1.45] text-ink-2">
        {diff}
      </pre>

      {prUrl ? (
        <p className="mb-4 font-mono text-[11px]">
          <a
            className="text-accent-4 underline hover:text-amber"
            href={prUrl}
            rel="noreferrer"
            target="_blank"
          >
            {labels.prLink}
            {prNumber ? ` #${prNumber}` : ""}
          </a>
        </p>
      ) : null}

      {conflictState ? (
        <div
          className="mb-4 rounded-[10px] border border-[#d9534f]/40 bg-[#d9534f]/10 p-4"
          data-testid="review-conflict"
          role="alert"
        >
          <p className="mb-2 font-mono text-[11px] font-bold text-[#d9534f]">
            {t("conflictTitle")}
          </p>
          <dl className="grid gap-1.5 font-mono text-[10.5px] text-ink-2">
            {conflictState.parentRepoPath ? (
              <div className="break-all">
                <dt className="inline text-mute">{t("conflictRepo")}: </dt>
                <dd className="inline">{conflictState.parentRepoPath}</dd>
              </div>
            ) : null}
            <div className="break-all">
              <dt className="inline text-mute">{t("conflictTarget")}: </dt>
              <dd className="inline">{conflictState.targetBranch}</dd>
            </div>
            <div className="break-all">
              <dt className="inline text-mute">{t("conflictRunBranch")}: </dt>
              <dd className="inline">{conflictState.runBranch}</dd>
            </div>
            <div className="break-all">
              <dt className="inline text-mute">{t("conflictCommand")}: </dt>
              <dd className="inline font-bold">{conflictState.command}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {legacyNeedsRelaunch ? (
        <p
          className="rounded-[10px] border border-amber-line bg-amber-soft p-4 font-mono text-[11px] leading-[1.5] text-amber"
          data-testid="review-relaunch"
          role="alert"
        >
          {t("relaunchToPromote")}
        </p>
      ) : !canPromote ? null : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
              {labels.promotionMode}
            </span>
            <select
              aria-label={labels.promotionMode}
              className="w-full max-w-[260px] rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-amber"
              value={mode}
              onChange={(event) => setMode(event.target.value as PromotionMode)}
            >
              <option value="local_merge">local_merge</option>
              <option value="pull_request">pull_request</option>
            </select>
          </label>

          {drift ? (
            <div
              className="rounded-[10px] border border-amber-line bg-amber-soft p-4"
              data-testid="review-drift"
              role="alert"
            >
              <p className="mb-3 font-mono text-[11px] leading-[1.5] text-amber">
                {labels.targetDrift}
              </p>
              <button
                className={clsx(
                  "inline-flex items-center justify-center rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white transition-all hover:bg-amber-2",
                  busy && "cursor-not-allowed opacity-60",
                )}
                disabled={busy}
                type="button"
                onClick={() => void promote(true)}
              >
                {labels.promoteAnyway}
              </button>
            </div>
          ) : (
            <button
              className={clsx(
                "inline-flex w-max items-center justify-center rounded-md bg-amber px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white transition-all hover:bg-amber-2",
                busy && "cursor-not-allowed opacity-60",
              )}
              disabled={busy || !targetBranch}
              type="button"
              onClick={() => void promote(false)}
            >
              {labels.promoteTo} {targetBranch}
            </button>
          )}

          {/* The live target HEAD this panel rendered against — carried into the
              promote payload as the optimistic-concurrency drift token. */}
          <input
            data-testid="reviewed-target-commit"
            name="reviewedTargetCommit"
            type="hidden"
            value={reviewedTargetCommit ?? ""}
          />

          {error ? (
            <p
              aria-live="polite"
              className="font-mono text-[10.5px] text-[#d9534f]"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
