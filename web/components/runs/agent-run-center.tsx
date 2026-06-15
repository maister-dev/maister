import type { ReactElement } from "react";
import type { FlowRunResultDto } from "@/lib/runs/flow-result-dto";

import Link from "next/link";

export interface AgentRunCenterLabels {
  title: string;
  subtitle: string;
  status: string;
  runner: string;
  latestActivity: string;
  noActivity: string;
  evidence: string;
  terminal: string;
  reviewChanges: string;
  openDiff: string;
}

export function shouldRenderAgentRunCenter(result: FlowRunResultDto): boolean {
  return (
    result.run.runKind === "agent" && result.graph.kind === "missing-manifest"
  );
}

function latestActivity(result: FlowRunResultDto): string | null {
  const latest = result.timeline.entries.at(-1);

  if (!latest) return null;

  return `${latest.nodeId} #${latest.attempt} · ${latest.status}`;
}

export function AgentRunCenter({
  result,
  labels,
}: {
  result: FlowRunResultDto;
  labels: AgentRunCenterLabels;
}): ReactElement {
  const latest = latestActivity(result);
  const showReviewCta =
    result.run.status === "Review" || result.review !== null;

  return (
    <section
      className="rounded-[14px] border border-line bg-paper p-5"
      data-testid="agent-run-center"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
            {labels.subtitle}
          </div>
          <h2 className="m-0 mt-1 font-sans text-[18px] font-bold tracking-[-0.01em] text-ink">
            {labels.title}
          </h2>
        </div>
        {showReviewCta ? (
          <Link
            className="rounded-full border border-line bg-ivory px-3 py-2 font-mono text-[11px] font-semibold text-ink hover:border-amber hover:text-amber"
            data-testid="agent-run-review-cta"
            href={`/runs/${result.run.runId}?wb=diff`}
          >
            {labels.reviewChanges}
          </Link>
        ) : null}
      </div>

      <dl className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
        {[
          [labels.status, result.run.status],
          [labels.runner, result.run.agent],
          [labels.latestActivity, latest ?? labels.noActivity],
          [labels.evidence, String(result.evidence.nodes.length)],
        ].map(([label, value]) => (
          <div key={label} className="bg-ivory px-3 py-2">
            <dt className="font-mono text-[9.5px] font-bold uppercase tracking-[0.08em] text-mute">
              {label}
            </dt>
            <dd className="m-0 mt-1 break-words font-mono text-[12px] font-semibold text-ink">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {result.run.endedAt ? (
        <div
          className="mt-3 inline-flex rounded-full border border-line bg-ivory px-2.5 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute"
          data-testid="agent-run-terminal"
        >
          {labels.terminal}
        </div>
      ) : null}

      {showReviewCta ? (
        <div className="mt-4">
          <Link
            className="font-mono text-[11px] font-semibold text-amber hover:text-ink"
            href={`/runs/${result.run.runId}?wb=diff`}
          >
            {labels.openDiff}
          </Link>
        </div>
      ) : null}
    </section>
  );
}
