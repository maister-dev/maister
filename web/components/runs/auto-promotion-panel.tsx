"use client";

import type { RunAutoPromotionPanel } from "@/lib/auto-promotion/panel";
import type { ReactElement } from "react";

import { CheckIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import clsx from "clsx";

// ADR-126 §4.8 / T17: the run-detail auto-promotion verdict surface. Reads the
// server-embedded `RunAutoPromotionPanel` (getRunDetail) for first paint; the
// eligible/grace countdown ticks client-side from `eligibleAt`. Hold → PUT,
// Release → DELETE `/api/runs/:id/promotion-hold`. A held run stops
// auto-promoting; releasing re-enters normal evaluation. The human Promote
// action (ReviewPanel) is unaffected — this only governs the sweep.

export interface AutoPromotionPanelProps {
  runId: string;
  panel: RunAutoPromotionPanel;
  // Whether the viewer may set/clear the hold (= the promoteRun project action).
  // The server route re-checks; this is UI consistency / defense-in-depth.
  canHold: boolean;
}

const CHIP =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10.5px] font-bold";
const ICON_BTN =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.04em] transition-colors";

// Format a positive remaining-ms into a compact `Xh`/`Xm`/`Xs` string. Rounds
// up so a sub-minute remainder still reads "1m" until it truly hits zero.
function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.ceil(seconds / 60);

  if (minutes < 60) return `${minutes}m`;

  return `${Math.ceil(minutes / 60)}h`;
}

// Live countdown to `targetIso`. Initial value is computed synchronously so the
// first (server) render is deterministic; the interval only runs client-side.
function useCountdown(targetIso: string): string {
  const target = new Date(targetIso).getTime();
  const [remaining, setRemaining] = useState(() => target - Date.now());

  useEffect(() => {
    const tick = (): void => setRemaining(target - Date.now());

    tick();

    const id = setInterval(tick, 1000);

    return () => clearInterval(id);
  }, [target]);

  return formatRemaining(remaining);
}

function EligibleChip({
  eligibleAt,
  labelPromotesIn,
  labelReady,
}: {
  eligibleAt: string;
  labelPromotesIn: (time: string) => string;
  labelReady: string;
}): ReactElement {
  const remaining = useCountdown(eligibleAt);
  const due = new Date(eligibleAt).getTime() <= Date.now();

  return (
    <span
      className={clsx(CHIP, "border-good bg-good-soft text-good")}
      data-countdown={remaining}
      data-testid="auto-promotion-eligible"
    >
      <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />
      {due ? labelReady : labelPromotesIn(remaining)}
    </span>
  );
}

export function AutoPromotionPanel({
  runId,
  panel,
  canHold,
}: AutoPromotionPanelProps): ReactElement | null {
  const t = useTranslations("autoPromotion");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [held, setHeld] = useState<null | "hold" | "release">(null);

  const { evaluation, promotedLane } = panel;

  async function mutateHold(method: "PUT" | "DELETE"): Promise<void> {
    setBusy(true);
    setError(false);

    try {
      const res = await fetch(`/api/runs/${runId}/promotion-hold`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "PUT" ? JSON.stringify({}) : undefined,
      });

      if (!res.ok) {
        setError(true);

        return;
      }

      setHeld(method === "PUT" ? "hold" : "release");
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  // A promoted run (Done) with no live evaluation: the audit note only.
  if (!evaluation) {
    if (!promotedLane) return null;

    return (
      <section
        className="mt-4 rounded-[10px] border border-good bg-good-soft/40 px-4 py-3"
        data-testid="auto-promotion-promoted"
      >
        <p className="m-0 inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-good">
          <CheckIcon aria-hidden="true" className="h-4 w-4" />
          {t("panel.promotedVia", { lane: promotedLane })}
        </p>
      </section>
    );
  }

  const holdButton = canHold ? (
    <button
      aria-label={t("panel.hold")}
      className={clsx(
        ICON_BTN,
        "border-amber-line bg-amber-soft text-amber hover:bg-amber-soft/70",
        busy && "opacity-60",
      )}
      data-testid="auto-promotion-hold"
      disabled={busy}
      type="button"
      onClick={() => void mutateHold("PUT")}
    >
      <PauseIcon aria-hidden="true" className="h-3.5 w-3.5" />
      {busy ? t("panel.holding") : t("panel.hold")}
    </button>
  ) : null;

  const releaseButton = canHold ? (
    <button
      aria-label={t("panel.release")}
      className={clsx(
        ICON_BTN,
        "border-good bg-good-soft text-good hover:bg-good-soft/70",
        busy && "opacity-60",
      )}
      data-testid="auto-promotion-release"
      disabled={busy}
      type="button"
      onClick={() => void mutateHold("DELETE")}
    >
      <PlayIcon aria-hidden="true" className="h-3.5 w-3.5" />
      {busy ? t("panel.releasing") : t("panel.release")}
    </button>
  ) : null;

  const successGlyph =
    held !== null ? (
      <span
        aria-label={
          held === "hold" ? t("panel.holdSuccess") : t("panel.releaseSuccess")
        }
        className="inline-flex items-center text-good"
        data-testid="auto-promotion-success"
        role="status"
        title={
          held === "hold" ? t("panel.holdSuccess") : t("panel.releaseSuccess")
        }
      >
        <CheckIcon className="h-4 w-4" />
      </span>
    ) : null;

  return (
    <section
      className="mt-4 rounded-[10px] border border-line bg-paper px-4 py-3"
      data-testid="auto-promotion-panel"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="m-0 font-sans text-[12.5px] font-bold tracking-[-0.005em] text-ink">
          {t("panel.title")}
        </h3>
        {successGlyph}
      </div>

      {evaluation.verdict === "eligible" ? (
        <div className="flex flex-wrap items-center gap-2">
          <EligibleChip
            eligibleAt={evaluation.eligibleAt}
            labelPromotesIn={(time) => t("panel.promotesIn", { time })}
            labelReady={t("panel.eligible")}
          />
          {holdButton}
        </div>
      ) : null}

      {evaluation.verdict === "held" ? (
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="auto-promotion-held"
        >
          <span
            className={clsx(CHIP, "border-amber-line bg-amber-soft text-amber")}
          >
            <PauseIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {t("panel.held")}
          </span>
          {evaluation.hold.reason ? (
            <span className="font-mono text-[10.5px] text-ink-2">
              <span className="text-mute">{t("panel.holdReason")}: </span>
              {evaluation.hold.reason}
            </span>
          ) : null}
          {releaseButton}
        </div>
      ) : null}

      {evaluation.verdict === "ineligible" ? (
        <div data-testid="auto-promotion-ineligible">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={clsx(CHIP, "border-line bg-ivory text-ink-2")}
              data-reason={evaluation.reason}
            >
              {evaluation.reason === "grace_pending" &&
              evaluation.eligibleAt ? (
                <GracePending
                  eligibleAt={evaluation.eligibleAt}
                  labelPromotesIn={(time) => t("panel.promotesIn", { time })}
                />
              ) : (
                t(`reason.${evaluation.reason}`)
              )}
            </span>
            {holdButton}
          </div>
          {evaluation.files && evaluation.files.length > 0 ? (
            <div className="mt-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                {t("panel.files")}
              </span>
              <ul className="mt-1 flex list-none flex-col gap-0.5 p-0 font-mono text-[10.5px] text-ink-2">
                {evaluation.files.map((f) => (
                  <li key={f} className="break-all">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {evaluation.detail ? (
            <p className="m-0 mt-1 font-mono text-[10.5px] text-mute break-all">
              {evaluation.detail}
            </p>
          ) : null}
        </div>
      ) : null}

      {evaluation.verdict === "disabled" ? (
        <p
          className="m-0 font-mono text-[11px] text-mute"
          data-testid="auto-promotion-disabled"
        >
          {evaluation.scope === "platform"
            ? t("panel.disabledPlatform")
            : t("panel.disabledProject")}
        </p>
      ) : null}

      {evaluation.verdict === "not_applicable" ? (
        <p
          className="m-0 font-mono text-[11px] text-mute"
          data-testid="auto-promotion-not-applicable"
        >
          {t(`notApplicable.${evaluation.reason}`)}
        </p>
      ) : null}

      {error ? (
        <p
          aria-live="polite"
          className="m-0 mt-2 font-mono text-[10.5px] text-[#d9534f]"
          role="alert"
        >
          {t("panel.error")}
        </p>
      ) : null}
    </section>
  );
}

// The grace-window countdown rendered inside the ineligible chip.
function GracePending({
  eligibleAt,
  labelPromotesIn,
}: {
  eligibleAt: string;
  labelPromotesIn: (time: string) => string;
}): ReactElement {
  const remaining = useCountdown(eligibleAt);

  return <span data-countdown={remaining}>{labelPromotesIn(remaining)}</span>;
}
