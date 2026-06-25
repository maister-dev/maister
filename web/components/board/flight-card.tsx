import type {
  FlightCard as FlightCardData,
  SpineSegment,
} from "@/lib/queries/board";
import type { ReadinessState } from "@/lib/flows/graph/readiness-core";
import type { ReactElement } from "react";

import Link from "next/link";
import clsx from "clsx";

import { FLOW_CHIP } from "@/components/board/task-card";
import { LaunchPopover } from "@/components/board/launch-popover";
import {
  TaskDecomposition,
  type TaskDecompositionLabels,
} from "@/components/board/task-decomposition";
import { READINESS_BADGE } from "@/components/readiness-badge";
import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";

export interface FlightCardLabels {
  reworking: string;
  // M11b (ADR-030) takeover surface, `board`-namespace strings.
  claimedBy: string;
  takeoverReturn: string;
  elapsed: string;
  // M11c (ADR-032) Phase 4.3: refused-at-launch settings indicator hint.
  settingsRefused: string;
  // T15 (M15, ADR-048): per-state readiness badge labels, sourced from the
  // `readiness.<state>` i18n namespace.
  readiness: Record<ReadinessState, string>;
  // M18 (T4.4): ready-to-promote / PR badge hint.
  readyToPromote: string;
  runsCount: (count: number) => string;
  launch: string;
  launchUnavailable: string;
  // Compact card: flowless chip fallback, the needs-attention badge, and the
  // accessible name for the whole-card stretched link to the run.
  unconfigured: string;
  needsAttention: string;
  // M37 (ADR-098): badge for a parked orchestrator (WaitingOnChildren) — it sits
  // in the InProduction column but is blocked on its run-tree children, not
  // actively working.
  waitingOnChildren: string;
  // ADR-111: "needs review" chip for a flagged task (held for a human).
  flagged: string;
  openRun: string;
  // M37 Phase 6 (ADR-098): localized labels for the orchestrator decomposition
  // group rendered under a parent task's flight card.
  decomposition: TaskDecompositionLabels;
}

export interface FlightCardProps {
  card: FlightCardData;
  slug: string;
  canAct: boolean;
  launchDisabledReason?: string;
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
  // M37 (ADR-098): a parked orchestrator — accent-2, distinct from accent-4
  // Running, so it reads as "blocked on children" not "actively working".
  waiting: "bg-accent-2",
};

const AGENT_PILL: Record<FlightCardData["agent"], string> = {
  claude: "text-amber bg-amber-soft border-amber-line",
  codex:
    "text-accent-3 bg-accent-3-soft border-[color-mix(in_oklab,var(--accent-3)_30%,var(--line))]",
  gemini:
    "text-accent-2 bg-accent-2-soft border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))]",
  opencode:
    "text-ink-2 bg-ivory border-[color-mix(in_oklab,var(--ink-2)_24%,var(--line))]",
  mimo: "text-ink bg-[color-mix(in_oklab,var(--ink)_8%,var(--paper))] border-[color-mix(in_oklab,var(--ink)_24%,var(--line))]",
  dev: "text-accent-4 bg-accent-4-soft border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))]",
};

const BADGE =
  "rounded-full border px-2 py-[3px] font-mono text-[10px] font-bold tracking-[0.04em]";

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

export function FlightCard({
  card,
  slug,
  canAct,
  launchDisabledReason,
  labels,
}: FlightCardProps): ReactElement {
  const isDone = card.status === "done";
  const isNeeds = card.status === "needs";
  const isRunning = card.status === "running";
  const isHumanWorking = card.status === "humanworking";
  const isWaiting = card.status === "waiting";
  const hasLifecycleActions = card.lifecycleActions.length > 0;
  const flowChip = card.flowRef
    ? (FLOW_CHIP[card.flowRef] ?? "text-mute bg-ivory border-line")
    : "text-danger bg-ivory border-line";

  const cardClass = clsx(
    "group/fc relative flex flex-col gap-2 overflow-hidden rounded-[10px] border px-3.5 pb-2.5 pt-2.5 transition-[transform,box-shadow,border-color]",
    "hover:-translate-y-px hover:border-[color-mix(in_oklab,var(--accent-4)_40%,var(--line))] hover:shadow-[0_8px_22px_-12px_rgba(22,20,15,0.16)]",
    isNeeds
      ? "border-amber-line bg-[linear-gradient(180deg,color-mix(in_oklab,var(--amber-soft)_30%,var(--paper))_0%,var(--paper)_60%)]"
      : isHumanWorking
        ? "border-[color-mix(in_oklab,var(--accent-3)_45%,var(--line))] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--accent-3-soft)_35%,var(--paper))_0%,var(--paper)_60%)]"
        : isDone
          ? "border-line bg-[color-mix(in_oklab,var(--ivory)_40%,var(--paper))] opacity-85 hover:opacity-100"
          : "border-line bg-paper",
  );

  return (
    <div className={cardClass} data-testid="flight-card">
      <span
        className={clsx(
          "absolute inset-y-0 left-0 w-[3px]",
          STRIPE[card.status],
        )}
      />

      {/* Whole-card stretched link → run. Sits above static content (so a click
          anywhere opens the run) but below the z-10 interactive children. */}
      <Link
        aria-label={`${labels.openRun}: ${card.title}`}
        className="absolute inset-0 z-0"
        data-testid="flight-card-open"
        href={`/runs/${card.runId}`}
      />

      <div className="flex items-center gap-2">
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
        <Link
          className="relative z-10 flex-none rounded border border-line bg-ivory px-1 py-px font-mono text-[9.5px] font-bold tracking-[0.05em] text-mute hover:border-amber hover:text-amber"
          href={`/projects/${slug}/tasks/${card.number}`}
        >
          {card.keyRef}
        </Link>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-[-0.005em] text-ink">
          {card.title}
        </span>
        <span
          className={clsx(
            "flex-none font-mono text-[10.5px] font-semibold tracking-[0.02em]",
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

      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={clsx(
            "flex-none rounded border px-[7px] py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[0.08em]",
            flowChip,
          )}
        >
          {card.flowRef ?? labels.unconfigured}
        </span>
        <span className={clsx(BADGE, AGENT_PILL[card.agent])}>
          {card.agent}
        </span>
        {isNeeds ? (
          <span
            className={clsx(
              BADGE,
              "border-amber-line bg-amber-soft text-amber",
            )}
            data-testid="flight-card-needs"
          >
            {labels.needsAttention}
          </span>
        ) : null}
        {isWaiting ? (
          <span
            className={clsx(BADGE, "border-line bg-paper text-accent-2")}
            data-testid="flight-card-waiting"
          >
            {labels.waitingOnChildren}
          </span>
        ) : null}
        {card.triageStatus === "flagged" ? (
          <span
            className={clsx(
              BADGE,
              "border-amber-line bg-amber-soft text-amber",
            )}
            data-testid="flight-card-flagged"
          >
            {labels.flagged}
          </span>
        ) : null}
        {card.refused ? (
          <span
            aria-label={labels.settingsRefused}
            className={clsx(
              BADGE,
              "border-amber-line bg-amber-soft text-amber",
            )}
            title={labels.settingsRefused}
          >
            ⚠
          </span>
        ) : null}
        {card.reworking ? (
          <span
            aria-label={labels.reworking}
            className={clsx(
              BADGE,
              "border-amber-line bg-amber-soft text-amber",
            )}
            title={labels.reworking}
          >
            ↺
          </span>
        ) : null}
        {!isDone && card.readiness !== "ready" ? (
          <span
            aria-label={labels.readiness[card.readiness]}
            className={clsx(
              BADGE,
              "uppercase",
              READINESS_BADGE[card.readiness],
            )}
            data-readiness={card.readiness}
            title={labels.readiness[card.readiness]}
          >
            {labels.readiness[card.readiness]}
          </span>
        ) : null}
        {card.readyToPromote ? (
          <span
            aria-label={labels.readyToPromote}
            className={clsx(
              BADGE,
              "border-[color-mix(in_oklab,var(--accent-4)_35%,var(--line))] bg-accent-4-soft text-accent-4",
            )}
            title={labels.readyToPromote}
          >
            {card.prNumber !== null ? `PR #${card.prNumber}` : "↗"}
          </span>
        ) : null}
        {card.runCount > 0 ? (
          <span
            className={clsx(BADGE, "border-line bg-ivory text-ink-2")}
            data-testid="board-runs-count"
          >
            {labels.runsCount(card.runCount)}
          </span>
        ) : null}
      </div>

      {isHumanWorking ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] leading-[1.4] tracking-[0.005em] text-ink-2">
          <span className="font-semibold text-accent-3">
            {labels.claimedBy}
          </span>
          <span className="min-w-0 truncate font-bold text-ink">
            {card.owner}
          </span>
          <span className="inline-flex items-center gap-1 rounded-[5px] border border-[color-mix(in_oklab,var(--accent-3)_40%,var(--line))] bg-paper px-2 py-[2px] text-[10px] font-bold tracking-[0.04em] text-accent-3">
            {labels.takeoverReturn} →
          </span>
        </div>
      ) : null}

      {!isDone && !isHumanWorking ? (
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-[5px]">
            {card.spine.map((seg, idx) => (
              <span
                key={idx}
                className={clsx(
                  "h-1 flex-1 rounded-[2px]",
                  segClass(seg, isNeeds),
                  seg.state === "now" &&
                    !isNeeds &&
                    "shadow-[0_0_0_0_var(--accent-4)] animate-[pulse-seg_2.4s_ease-out_infinite]",
                )}
              />
            ))}
          </div>
          <span className="max-w-[48%] flex-none truncate font-mono text-[10px] tracking-[0.02em] text-mute">
            {card.stepLabel}
          </span>
        </div>
      ) : null}

      {canAct ? (
        <div className="relative z-10 flex items-center justify-end border-t border-dashed border-line-soft pt-2">
          <LaunchPopover
            disabledLabel={labels.launchUnavailable}
            disabledReason={launchDisabledReason}
            label={labels.launch}
            taskId={card.taskId}
          />
        </div>
      ) : null}

      {hasLifecycleActions ? (
        <div className="relative z-10">
          <WorkbenchLifecycleActions
            actions={card.lifecycleActions}
            runId={card.runId}
            runKind="flow"
          />
        </div>
      ) : null}

      {card.childTasks.length > 0 ? (
        <div className="relative z-10">
          <TaskDecomposition
            childTasks={card.childTasks}
            labels={labels.decomposition}
            slug={slug}
          />
        </div>
      ) : null}
    </div>
  );
}
