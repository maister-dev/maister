import type {
  FlightCard as FlightCardData,
  SpineSegment,
} from "@/lib/queries/board";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

export interface FlightCardLabels {
  reworking: string;
  // M11b (ADR-030) takeover surface, `board`-namespace strings.
  claimedBy: string;
  takeoverReturn: string;
  elapsed: string;
  // M11c (ADR-032) Phase 4.3: refused-at-launch settings indicator hint.
  settingsRefused: string;
  // M12 (ADR-037) Phase 7: evidence-graph badge hints.
  evidenceStale: string;
  mergeBlocked: string;
}

export interface FlightCardProps {
  card: FlightCardData;
  labels: FlightCardLabels;
}

const STRIPE: Record<FlightCardData["status"], string> = {
  running: "bg-accent-4",
  needs: "bg-amber",
  queued: "bg-mute-2",
  crashed: "bg-red-500",
  done: "bg-accent-4 opacity-50",
  // M11b: a claimed run reuses the `dev`/accent-4 stripe but the card body
  // makes it unmistakably a manual-takeover surface, not a normal running task.
  humanworking: "bg-accent-3",
};

const AGENT_PILL: Record<FlightCardData["agent"], string> = {
  claude: "text-amber bg-amber-soft border-amber-line",
  codex:
    "text-accent-3 bg-accent-3-soft border-[color-mix(in_oklab,var(--accent-3)_30%,var(--line))]",
  dev: "text-accent-4 bg-accent-4-soft border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))]",
};

function segClass(seg: SpineSegment, needs: boolean): string {
  if (seg.state === "done") return "bg-accent-4 opacity-[0.65]";
  if (seg.state === "skip") {
    return "bg-[repeating-linear-gradient(45deg,var(--line)_0_2px,transparent_2px_4px)]";
  }
  if (seg.state === "now") {
    return needs ? "bg-amber" : "bg-accent-4";
  }

  return "bg-line";
}

export function FlightCard({ card, labels }: FlightCardProps): ReactElement {
  const isDone = card.status === "done";
  const isNeeds = card.status === "needs";
  const isRunning = card.status === "running";
  const isHumanWorking = card.status === "humanworking";

  return (
    <Link
      className={clsx(
        "group/fc relative flex flex-col gap-2.5 overflow-hidden rounded-[10px] border px-3.5 pb-3 pt-3 transition-[transform,box-shadow,border-color] hover:-translate-y-px hover:border-[color-mix(in_oklab,var(--accent-4)_40%,var(--line))] hover:shadow-[0_8px_22px_-12px_rgba(22,20,15,0.16)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber",
        isNeeds
          ? "border-amber-line bg-[linear-gradient(180deg,color-mix(in_oklab,var(--amber-soft)_30%,var(--paper))_0%,var(--paper)_60%)]"
          : isHumanWorking
            ? "border-[color-mix(in_oklab,var(--accent-3)_45%,var(--line))] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--accent-3-soft)_35%,var(--paper))_0%,var(--paper)_60%)]"
            : isDone
              ? "border-line bg-[color-mix(in_oklab,var(--ivory)_40%,var(--paper))] opacity-85 hover:opacity-100"
              : "border-line bg-paper",
      )}
      href={`/runs/${card.runId}`}
    >
      <span
        className={clsx(
          "absolute inset-y-0 left-0 w-[3px]",
          STRIPE[card.status],
        )}
      />

      <div className="flex items-center justify-between gap-2.5">
        <div className="inline-flex min-w-0 items-center gap-2 font-mono text-[12.5px] font-bold tracking-[-0.005em] text-ink">
          <span
            className={clsx(
              "h-2 w-2 flex-none rounded-full",
              isRunning
                ? "bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]"
                : isNeeds
                  ? "bg-amber"
                  : isHumanWorking
                    ? "bg-accent-3"
                    : "bg-mute-2",
            )}
          />
          <span className="truncate">{card.branch}</span>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {card.refused ? (
            <span
              aria-label={labels.settingsRefused}
              className="rounded-full border border-amber-line bg-amber-soft px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.04em] text-amber"
              title={labels.settingsRefused}
            >
              ⚠
            </span>
          ) : null}
          {card.reworking ? (
            <span
              aria-label={labels.reworking}
              className="rounded-full border border-amber-line bg-amber-soft px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.04em] text-amber"
              title={labels.reworking}
            >
              ↺
            </span>
          ) : null}
          {card.mergeBlocked ? (
            <span
              aria-label={labels.mergeBlocked}
              className="rounded-full border border-amber-line bg-amber-soft px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.04em] text-amber"
              title={labels.mergeBlocked}
            >
              ◆
            </span>
          ) : null}
          {card.evidenceStale ? (
            <span
              aria-label={labels.evidenceStale}
              className="rounded-full border border-amber-line bg-amber-soft px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.04em] text-amber"
              title={labels.evidenceStale}
            >
              ≈
            </span>
          ) : null}
          <span
            className={clsx(
              "rounded-full border px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.04em]",
              AGENT_PILL[card.agent],
            )}
          >
            {card.agent}
          </span>
        </div>
      </div>

      {isHumanWorking ? (
        <div className="flex flex-col gap-2 rounded-[7px] border border-[color-mix(in_oklab,var(--accent-3)_30%,var(--line))] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--accent-3-soft)_40%,var(--paper))_0%,var(--paper)_100%)] px-2.5 py-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] leading-[1.4] tracking-[0.005em] text-ink-2">
            <span className="font-semibold text-accent-3">
              {labels.claimedBy}
            </span>
            <span className="min-w-0 truncate font-bold text-ink">
              {card.owner}
            </span>
          </span>
          <span className="inline-flex w-fit items-center gap-1 rounded-[5px] border border-[color-mix(in_oklab,var(--accent-3)_40%,var(--line))] bg-paper px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.04em] text-accent-3">
            {labels.takeoverReturn} →
          </span>
        </div>
      ) : null}

      {!isDone && !isHumanWorking ? (
        <div
          className={clsx(
            "flex items-center gap-2 rounded-[7px] border px-2.5 py-2 font-mono text-[11px] leading-[1.4] tracking-[0.005em] text-ink-2",
            isNeeds
              ? "border-amber-line bg-[linear-gradient(180deg,color-mix(in_oklab,var(--amber-soft)_40%,var(--paper))_0%,var(--paper)_100%)]"
              : "border-line-soft bg-[linear-gradient(180deg,color-mix(in_oklab,var(--accent-4-soft)_35%,var(--paper))_0%,var(--paper)_100%)]",
          )}
        >
          <span
            className={clsx(
              "flex-none rounded-[3px] border bg-paper px-[5px] py-px text-[9px] font-bold uppercase tracking-[0.12em]",
              isNeeds
                ? "border-amber-line text-amber"
                : "border-line text-mute",
            )}
          >
            {card.stepLabel}
          </span>
          <span className="min-w-0 flex-1 truncate">{card.stepBody}</span>
        </div>
      ) : null}

      {!isDone && !isHumanWorking ? (
        <div className="flex items-center gap-[5px] px-0.5 py-0.5">
          {card.spine.map((seg, idx) => (
            <span
              key={idx}
              className={clsx(
                "h-1 flex-1 rounded-[2px]",
                segClass(seg, isNeeds),
                seg.state === "now" &&
                  (isNeeds
                    ? "shadow-[0_0_0_0_var(--amber)]"
                    : "shadow-[0_0_0_0_var(--accent-4)] animate-[pulse-seg_2.4s_ease-out_infinite]"),
              )}
            />
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2.5 border-t border-dashed border-line-soft pt-2 font-mono text-[10.5px] tracking-[0.02em] text-mute">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-1 font-semibold text-ink-2">
            {card.branch}
          </span>
          {card.plus !== null && card.minus !== null ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="font-bold text-accent-4">+{card.plus}</span>
              {" / "}
              <span className="font-bold text-amber">−{card.minus}</span>
            </span>
          ) : null}
        </div>
        <span
          className={clsx(
            "font-semibold",
            isNeeds
              ? "text-amber"
              : isHumanWorking
                ? "text-accent-3 before:content-['⏱_']"
                : isDone
                  ? "text-mute-2 before:font-bold before:text-accent-4 before:content-['✓_']"
                  : "text-mute-2",
          )}
          title={isHumanWorking ? labels.elapsed : undefined}
        >
          {card.time}
        </span>
      </div>
    </Link>
  );
}
