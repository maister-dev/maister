"use client";

/**
 * The BODY of a HITL request — actions, and the lazily-loaded run context behind
 * a disclosure the PARENT owns (ADR-174 `REQ-D16`/`REQ-D17`).
 *
 * Extracted from `HitlCard`, which was monolithic and therefore renderable only
 * as a card. The Desk needs this body inside a table row, where the row is the
 * header; `/inbox` is rebuilt on the same component, so the two surfaces render
 * ONE implementation rather than two that drift.
 *
 * `expanded` is a prop, not state: whoever owns the header owns the disclosure.
 * The fetch is this component's, because the loading and error branches belong
 * with the thing that loads.
 */

import type { HitlItem } from "@/lib/queries/hitl";
import type {
  InboxCardContext,
  InboxGateChip,
} from "@/lib/queries/inbox-context";
import type { ReactElement, ReactNode } from "react";

import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  MinusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { AssignmentActions } from "@/components/board/assignment-actions";
import { RunHitlResponse } from "@/components/board/run-hitl-response";
import { runReviewHref } from "@/lib/runs/run-query-state";

type GateTone = "ok" | "warn" | "bad" | "muted";

const GATE_TONE: Record<string, GateTone> = {
  passed: "ok",
  failed: "bad",
  stale: "warn",
  pending: "warn",
  running: "warn",
  skipped: "muted",
  overridden: "muted",
};

const GATE_TONE_CLASS: Record<GateTone, string> = {
  ok: "border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))] bg-[color-mix(in_oklab,var(--accent-2)_10%,var(--paper))] text-accent-2",
  warn: "border-amber-line bg-amber-soft text-amber",
  bad: "border-[color-mix(in_oklab,var(--status-red)_35%,var(--line))] bg-[color-mix(in_oklab,var(--status-red)_12%,var(--paper))] text-[var(--status-red)]",
  muted: "border-line bg-ivory text-mute",
};

function GateIcon({ tone }: { tone: GateTone }): ReactElement {
  const cls = "h-3 w-3";

  if (tone === "ok") return <CheckIcon className={cls} />;
  if (tone === "bad") return <XMarkIcon className={cls} />;
  if (tone === "warn") return <ClockIcon className={cls} />;

  return <MinusIcon className={cls} />;
}

const MAX_GATE_CHIPS = 5;

export function Chip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] tracking-[0.02em]",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function staleCount(summary: Record<string, unknown> | null): number {
  if (summary === null) return 0;
  const count = summary.count;

  return typeof count === "number" && count > 0 ? count : 0;
}

export function isReviewGate(item: HitlItem): boolean {
  return (
    item.kind === "human" &&
    typeof item.schema === "object" &&
    item.schema !== null &&
    !Array.isArray(item.schema) &&
    (item.schema as { review?: unknown }).review === true
  );
}

export interface HitlPanelProps {
  item: HitlItem;
  canAct: boolean;
  currentUserId: string;
  /** Owned by the parent — the card's header button, or the Desk's table row. */
  expanded: boolean;
  /**
   * Lets the panel ASK to be expanded without owning the state. The "Respond"
   * affordance needs the context region open to be useful, and the parent is
   * the only thing that can open it.
   */
  onRequestExpand?: () => void;
}

export function HitlPanel({
  item,
  canAct,
  currentUserId,
  expanded,
  onRequestExpand,
}: HitlPanelProps): ReactElement {
  const t = useTranslations("inbox");
  const tb = useTranslations("board");
  const router = useRouter();
  const [context, setContext] = useState<InboxCardContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Gates the AUTO-load, not the render: one request per panel, ever. Retry is
  // the reader's explicit decision below.
  const [requested, setRequested] = useState(false);

  const loadContext = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(false);

    try {
      const res = await fetch(`/api/runs/${item.runId}/inbox-context`);

      if (!res.ok) throw new Error("inbox-context");
      setContext((await res.json()) as InboxCardContext);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [item.runId]);

  // `REQ-D16`: on FIRST EXPAND, never on mount. The Desk may hold many
  // `WaitingOnHuman` rows, and a mount-time fetch would fire one request per row
  // on page load — invisible in review, obvious in production.
  useEffect(() => {
    if (!expanded || requested) return;
    setRequested(true);
    void loadContext();
  }, [expanded, requested, loadContext]);

  const stale = staleCount(item.assignmentStaleEvidenceSummary);
  const isPermission = item.kind === "permission";
  const isAgentQuestion = item.kind === "agent_question";
  const isReview = isReviewGate(item);
  const budgetClaimCanBeReplaced =
    item.kind === "budget_breach" && item.claimStage === "failed";
  const reviewHref = runReviewHref(item.runId);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-2.5">
        {isReview && item.answerState === "open" ? (
          <a
            className="inline-flex items-center gap-1.5 rounded-md border border-amber bg-amber px-2.5 py-1 font-mono text-[11px] font-semibold text-white transition-colors hover:bg-amber-2"
            href={reviewHref}
          >
            {t("reviewCode")}
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          </a>
        ) : (isPermission && canAct) ||
          (item.answerState === "answer_stored" &&
            !budgetClaimCanBeReplaced) ? (
          <RunHitlResponse
            compact
            answerState={item.answerState}
            availableOptions={item.availableOptions}
            canAct={canAct}
            claimStage={item.claimStage}
            criticality={item.criticality}
            hitlRequestId={item.hitlRequestId}
            kind={item.kind}
            options={item.options}
            runId={item.runId}
            schema={item.schema}
            storedResponse={item.storedResponse}
            // `router.refresh()`, not `window.location.reload()`: this panel now
            // renders inside a Desk row whose expansion is client state, and a
            // full reload would collapse every open row on the page. The RSC
            // refetch shows the same answered state — it is what the non-
            // permission arm below has always used.
            onRespond={() => router.refresh()}
          />
        ) : canAct ? (
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-ivory px-2.5 py-1 font-mono text-[11px] font-semibold text-ink-2 transition-colors hover:bg-paper"
            type="button"
            onClick={() => {
              if (!expanded) onRequestExpand?.();
            }}
          >
            {isAgentQuestion ? t("answerClarification") : t("respond")}
          </button>
        ) : null}

        <AssignmentActions
          assigneeUserId={item.assigneeUserId}
          assignmentId={item.assignmentId}
          canAct={canAct}
          currentUserId={currentUserId}
          labels={{
            claim: tb("assignmentClaim"),
            release: tb("assignmentRelease"),
            takeOver: tb("assignmentTakeOver"),
          }}
          status={item.assignmentStatus}
        />

        <a
          className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-accent-2 hover:underline"
          href={isReview ? reviewHref : `/runs/${item.runId}`}
        >
          {t("viewRun")}
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
        </a>
      </div>

      {expanded ? (
        <div
          className="border-t border-line bg-[color-mix(in_oklab,var(--ivory)_50%,var(--paper))] px-4 py-3.5"
          data-testid="hitl-panel-context"
        >
          {loading ? (
            <div className="font-mono text-[11px] text-mute" role="status">
              {t("contextLoading")}
            </div>
          ) : error ? (
            <div
              className="flex items-center gap-3 font-mono text-[11px] text-[var(--status-red)]"
              role="alert"
            >
              {t("contextError")}
              <button
                className="rounded border border-line bg-paper px-2 py-0.5 text-ink-2 hover:bg-ivory"
                type="button"
                onClick={() => void loadContext()}
              >
                {t("retry")}
              </button>
            </div>
          ) : context ? (
            <ExpandedContext context={context} stale={stale} t={t} />
          ) : null}

          {!isReview &&
          !isPermission &&
          (item.answerState !== "answer_stored" || budgetClaimCanBeReplaced) &&
          canAct ? (
            <div className="mt-3.5 border-t border-line pt-3.5">
              <RunHitlResponse
                compact
                answerState={item.answerState}
                availableOptions={
                  item.kind === "budget_breach"
                    ? (context?.availableOptions ?? item.availableOptions)
                    : item.availableOptions
                }
                budgetProgress={context?.budgetProgress ?? null}
                canAct={canAct}
                claimStage={context?.claimStage ?? item.claimStage}
                criticality={item.criticality}
                hitlRequestId={item.hitlRequestId}
                kind={item.kind}
                nodeInterrupt={item.nodeInterrupt}
                options={item.options}
                runId={item.runId}
                schema={item.schema}
                storedResponse={item.storedResponse}
                onRespond={() => router.refresh()}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
        {label}
      </div>
      {children}
    </div>
  );
}

function ExpandedContext({
  context,
  stale,
  t,
}: {
  context: InboxCardContext;
  stale: number;
  t: ReturnType<typeof useTranslations>;
}): ReactElement {
  // Blocking gates first, then advisory; cap the chips and roll the rest into
  // a "+k more" chip.
  const ordered = [...context.gates].sort(
    (a, b) => Number(b.mode === "blocking") - Number(a.mode === "blocking"),
  );
  const shown = ordered.slice(0, MAX_GATE_CHIPS);
  const overflow = ordered.length - shown.length;

  return (
    <>
      {context.gates.length > 0 || stale > 0 ? (
        <Section label={t("gatesEvidence")}>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((gate: InboxGateChip) => {
              const tone = GATE_TONE[gate.status] ?? "muted";

              return (
                <Chip key={gate.gateId} className={GATE_TONE_CLASS[tone]}>
                  <GateIcon tone={tone} />
                  {gate.gateId}
                </Chip>
              );
            })}
            {overflow > 0 ? (
              <Chip className="border-line bg-ivory text-mute">
                {t("moreGates", { count: overflow })}
              </Chip>
            ) : null}
            {stale > 0 ? (
              <Chip className="border-line bg-ivory text-mute">
                <ExclamationTriangleIcon className="h-3 w-3" />
                {t("staleEvidence", { count: stale })}
              </Chip>
            ) : null}
          </div>
        </Section>
      ) : null}

      {context.lastAgentMessage ? (
        <Section label={t("lastAgentMessage")}>
          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-paper px-3 py-2 text-[12.5px] leading-[1.5] text-ink-2">
            {context.lastAgentMessage.text}
          </div>
        </Section>
      ) : null}

      {context.progress ? (
        <Section label={t("stageProgress")}>
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-line">
              <div
                className="h-full bg-accent-2"
                style={{
                  width: `${Math.round(
                    (context.progress.done / context.progress.total) * 100,
                  )}%`,
                }}
              />
            </div>
            <span className="font-mono text-[11px] text-ink-2">
              {context.progress.done} / {context.progress.total}
            </span>
          </div>
        </Section>
      ) : null}

      {context.diff ? (
        <Section label={t("changes")}>
          <span className="font-mono text-[11.5px] text-ink-2">
            {t("changesSummary", {
              files: context.diff.files,
              additions: context.diff.additions,
              deletions: context.diff.deletions,
            })}
          </span>
        </Section>
      ) : null}
    </>
  );
}
