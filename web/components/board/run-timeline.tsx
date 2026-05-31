import type { ReactElement } from "react";

import clsx from "clsx";

export interface TimelineGateView {
  gateId: string;
  kind: string;
  mode: string;
  status: string;
  verdict: { verdict: string } | null;
  stale: boolean;
  endedAt: string | null;
}

export interface TimelineHandoffView {
  ownerUserId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  baseRef: string | null;
  returnedCommits: string | null;
  returnedDiff: string | null;
}

export interface TimelineEntry {
  nodeAttemptId: string;
  nodeId: string;
  nodeType: string;
  attempt: number;
  status: string;
  decision: string | null;
  reworkFromNode: string | null;
  acpSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  gates: TimelineGateView[];
  handoff: TimelineHandoffView | null;
}

export interface TimelineLabels {
  title: string;
  staleGate: string;
  currentGate: string;
  rerunRequired: string;
  handoff: string;
  claimedBy: string;
  elapsed: string;
  returnedCommits: string;
  returnedDiff: string;
  empty: string;
  decisionLabel: (decision: string) => string;
}

export interface RunTimelineProps {
  entries: TimelineEntry[];
  labels: TimelineLabels;
}

function ownerLabel(h: TimelineHandoffView): string {
  return h.ownerName ?? h.ownerEmail ?? h.ownerUserId;
}

function GateRow({
  gate,
  labels,
}: {
  gate: TimelineGateView;
  labels: TimelineLabels;
}): ReactElement {
  return (
    <li className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
      <span
        className={clsx(
          "flex-none rounded-[3px] border px-[5px] py-px text-[9px] font-bold uppercase tracking-[0.12em]",
          gate.stale
            ? "border-line bg-ivory text-mute line-through"
            : gate.status === "passed"
              ? "border-[color-mix(in_oklab,var(--accent-4)_40%,var(--line))] bg-accent-4-soft text-accent-4"
              : gate.status === "failed"
                ? "border-amber-line bg-amber-soft text-amber"
                : "border-line bg-paper text-mute",
        )}
      >
        {gate.status}
      </span>
      <span
        className={clsx(
          "min-w-0 truncate",
          gate.stale ? "text-mute line-through" : "text-ink-2",
        )}
      >
        {gate.gateId}
        <span className="text-mute"> · {gate.kind}</span>
      </span>
      {gate.stale ? (
        <span className="flex-none rounded-full border border-amber-line bg-amber-soft px-2 py-[2px] text-[9px] font-bold uppercase tracking-[0.06em] text-amber">
          {labels.rerunRequired}
        </span>
      ) : null}
    </li>
  );
}

function HandoffBlock({
  handoff,
  startedAt,
  labels,
}: {
  handoff: TimelineHandoffView;
  startedAt: string;
  labels: TimelineLabels;
}): ReactElement {
  return (
    <div className="mt-2 rounded-[8px] border border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-accent-4-soft/40 p-3">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-accent-4">
        <span className="font-bold">{labels.handoff}</span>
        <span className="text-mute normal-case tracking-normal">
          {labels.claimedBy} {ownerLabel(handoff)}
        </span>
        {handoff.baseRef ? (
          <span className="text-mute normal-case tracking-normal">
            · {handoff.baseRef}
          </span>
        ) : null}
        <span
          suppressHydrationWarning
          className="text-mute normal-case tracking-normal"
        >
          · {labels.elapsed} {new Date(startedAt).toLocaleString()}
        </span>
      </div>

      {handoff.returnedCommits ? (
        <div className="mt-2">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
            {labels.returnedCommits}
          </div>
          <pre className="mt-1 overflow-auto rounded-[6px] border border-line-soft bg-paper p-2 font-mono text-[11px] leading-[1.5] text-ink-2">
            {handoff.returnedCommits}
          </pre>
        </div>
      ) : null}

      {handoff.returnedDiff ? (
        <div className="mt-2">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
            {labels.returnedDiff}
          </div>
          <pre className="mt-1 max-h-[420px] overflow-auto rounded-[6px] border border-line-soft bg-ivory p-2 font-mono text-[11px] leading-[1.5] text-ink-2">
            {handoff.returnedDiff}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function EntryCard({
  entry,
  labels,
}: {
  entry: TimelineEntry;
  labels: TimelineLabels;
}): ReactElement {
  const isStale = entry.status === "Stale";

  return (
    <li
      className={clsx(
        "rounded-[10px] border px-3.5 py-3",
        isStale
          ? "border-line bg-[color-mix(in_oklab,var(--ivory)_40%,var(--paper))] opacity-85"
          : "border-line bg-paper",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex min-w-0 items-center gap-2 font-mono text-[12.5px] font-bold tracking-[-0.005em] text-ink">
          <span
            className={clsx("truncate", isStale && "line-through text-mute")}
          >
            {entry.nodeId}
          </span>
          <span className="flex-none rounded-full border border-line bg-ivory px-2 py-[2px] font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-mute">
            #{entry.attempt}
          </span>
          <span className="flex-none font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            {entry.nodeType}
          </span>
        </div>
        <div className="flex flex-none items-center gap-1.5 font-mono text-[10px]">
          {entry.decision ? (
            <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-[2px] font-bold uppercase tracking-[0.06em] text-amber">
              {labels.decisionLabel(entry.decision)}
            </span>
          ) : null}
          <span
            className={clsx(
              "rounded-full border px-2 py-[2px] font-semibold uppercase tracking-[0.06em]",
              isStale
                ? "border-line bg-ivory text-mute"
                : "border-line bg-paper text-ink-2",
            )}
          >
            {entry.status}
          </span>
        </div>
      </div>

      {entry.acpSessionId ? (
        <div className="mt-1 font-mono text-[10px] text-mute">
          ↪ {entry.acpSessionId}
        </div>
      ) : null}

      {entry.gates.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {entry.gates.map((g) => (
            <GateRow key={g.gateId} gate={g} labels={labels} />
          ))}
        </ul>
      ) : null}

      {entry.handoff ? (
        <HandoffBlock
          handoff={entry.handoff}
          labels={labels}
          startedAt={entry.startedAt}
        />
      ) : null}
    </li>
  );
}

export function RunTimeline({
  entries,
  labels,
}: RunTimelineProps): ReactElement {
  return (
    <section className="mt-8">
      <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
        {labels.title}
      </h2>
      {entries.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-line p-6 text-center font-mono text-[12px] text-mute">
          {labels.empty}
        </p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {entries.map((entry) => (
            <EntryCard
              key={entry.nodeAttemptId}
              entry={entry}
              labels={labels}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
