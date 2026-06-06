import type { CrossProjectHitlItem } from "@/lib/queries/portfolio";
import type { ReactElement, ReactNode } from "react";

import clsx from "clsx";

export interface HitlInboxBlockLabels {
  title: string;
  empty: string;
  ariaLabel: string;
  countAriaLabel: string;
  [key: string]: string;
}

export interface HitlInboxBlockProps {
  items: CrossProjectHitlItem[];
  count: number;
  labels: HitlInboxBlockLabels;
  // Optional slot for the inline respond widget per item.
  // The page passes a "use client" wrapper; tests omit it (pure static render).
  renderRespond?: (item: CrossProjectHitlItem) => ReactNode;
}

const CRITICALITY_BADGE: Record<string, string> = {
  critical:
    "border-[color-mix(in_oklab,var(--status-red)_35%,var(--line))] bg-[color-mix(in_oklab,var(--status-red)_12%,var(--paper))] text-[var(--status-red)]",
  high: "border-amber-line bg-amber-soft text-amber",
  medium:
    "border-[color-mix(in_oklab,var(--accent-2)_30%,var(--line))] bg-[color-mix(in_oklab,var(--accent-2)_10%,var(--paper))] text-accent-2",
  low: "border-line bg-ivory text-mute",
};

const AGENT_BADGE: Record<string, string> = {
  claude: "bg-amber text-white",
  codex: "bg-accent-3 text-white",
};

export function HitlInboxBlock({
  items,
  count,
  labels,
  renderRespond,
}: HitlInboxBlockProps): ReactElement {
  return (
    <section
      aria-label={labels.ariaLabel}
      className="mb-6 overflow-hidden rounded-[14px] border border-amber-line bg-[linear-gradient(180deg,color-mix(in_oklab,var(--amber-soft)_90%,transparent)_0%,color-mix(in_oklab,var(--amber-soft)_55%,var(--paper))_100%)]"
      data-testid="cross-project-hitl-inbox"
    >
      <div className="flex items-center justify-between px-[18px] pb-2 pt-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] text-amber before:h-1.5 before:w-1.5 before:rounded-full before:bg-amber before:content-[''] before:animate-[pulse-dot_2.2s_ease-out_infinite]">
            {labels.title}
          </span>
          <span
            aria-label={labels.countAriaLabel}
            className="rounded-full border border-amber-line bg-paper px-2.5 py-[3px] font-mono text-[10px] font-bold tracking-[0.04em] text-amber"
          >
            {count}
          </span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="border-t border-amber-line px-[18px] py-4 font-mono text-[11px] text-mute">
          {labels.empty}
        </div>
      ) : (
        <div className="flex flex-col gap-px border-t border-amber-line bg-amber-line">
          {items.map((item) => (
            <article
              key={item.hitlRequestId}
              className="grid grid-cols-[auto_1fr_auto] items-start gap-4 bg-paper px-[18px] py-4"
            >
              {/* Agent avatar */}
              <div
                className={clsx(
                  "inline-flex h-8 w-8 flex-none items-center justify-center rounded-[8px] font-mono text-[10px] font-extrabold tracking-[0.02em]",
                  AGENT_BADGE[item.agent] ?? "bg-mute text-white",
                )}
              >
                {item.agent === "claude" ? "cl" : "cx"}
              </div>

              {/* Main content */}
              <div className="min-w-0">
                {/* Project name, branch, flow ref, agent, criticality */}
                <div className="mb-0.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] tracking-[0.02em] text-mute">
                  <b className="font-semibold text-ink">{item.projectName}</b>
                  <span className="text-mute-2">·</span>
                  <code className="rounded-[3px] border border-line bg-paper px-[5px] py-px text-[10px] text-ink-2">
                    {item.branch}
                  </code>
                  <span className="text-mute-2">·</span>
                  <span className="font-semibold text-amber">
                    {item.flowRef}
                  </span>
                  <span className="text-mute-2">·</span>
                  <span>{item.agent}</span>
                  {item.criticality !== null ? (
                    <>
                      <span className="text-mute-2">·</span>
                      <span
                        className={clsx(
                          "rounded border px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.04em]",
                          CRITICALITY_BADGE[item.criticality] ??
                            "border-line bg-ivory text-mute",
                        )}
                        data-criticality={item.criticality}
                      >
                        {item.criticality}
                      </span>
                    </>
                  ) : null}
                </div>

                {/* Prompt */}
                <div className="text-sm font-medium leading-[1.4] tracking-[-0.005em] text-ink">
                  {item.prompt}
                </div>

                {/* Time + assignment state */}
                <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10.5px] tracking-[0.02em] text-mute">
                  <span className="font-bold text-amber">{item.time}</span>
                  {item.assigneeLabel !== null ? (
                    <>
                      <span className="text-mute-2">·</span>
                      <span className="text-ink-2">{item.assigneeLabel}</span>
                    </>
                  ) : null}
                  {item.assignmentStatus !== null ? (
                    <>
                      <span className="text-mute-2">·</span>
                      <span className="text-ink-2">
                        {item.assignmentStatus}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Respond slot — "use client" wrapper provided by the page */}
              {renderRespond ? (
                <div className="flex-none">{renderRespond(item)}</div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
