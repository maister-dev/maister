"use client";

import type { ReactElement, ReactNode } from "react";
import type {
  FlowRunNodeDto,
  FlowRunResultDto,
} from "@/lib/runs/flow-result-dto";
import type {
  FlowNodeArtifactResult,
  FlowNodeAttemptResult,
  FlowNodeGateResult,
  FlowNodeHitlResult,
  FlowNodeReadinessResult,
  FlowNodeResultDto,
  FlowNodeReviewResult,
} from "@/lib/runs/flow-node-result";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import clsx from "clsx";

import { NodeStatusIcon } from "@/components/runs/node-status-icon";
import {
  NodeTranscriptPanel,
  type NodeTranscriptPanelLabels,
  transcriptPanelDefaultOpen,
} from "@/components/runs/node-transcript-panel";
import { buildFlowNodeResult } from "@/lib/runs/flow-node-result";
import { isLiveRunStatus } from "@/lib/runs/live-inspector";
import { buildRunHref, parseRunQueryState } from "@/lib/runs/run-query-state";

export interface FlowRunCenterLabels {
  title: string;
  fullscreen: string;
  reviewChanges: string;
  nodes: string;
  selectedNode: string;
  currentNode: string;
  status: string;
  attempt: string;
  attempts: string;
  gates: string;
  artifacts: string;
  hitl: string;
  review: string;
  readiness: string;
  failed: string;
  reworked: string;
  openThreads: string;
  outdatedThreads: string;
  options: string;
  tokens: string;
  prompt: string;
  promptCopy: string;
  noGraph: string;
  noNode: string;
  // Localized node-status labels keyed by node_attempts.status (run.nodeStatus.*).
  nodeStatus: Record<string, string>;
  // Per-node agent transcript panel labels (run.transcript.*).
  transcript: NodeTranscriptPanelLabels;
}

export function selectFlowRunNode(
  result: FlowRunResultDto,
  requestedNodeId: string | null,
): FlowRunNodeDto | null {
  if (result.graph.kind !== "ready") return null;

  const byId = new Map(result.graph.nodes.map((node) => [node.id, node]));
  const requested =
    requestedNodeId !== null ? (byId.get(requestedNodeId) ?? null) : null;
  const current =
    result.graph.currentNodeId !== null
      ? (byId.get(result.graph.currentNodeId) ?? null)
      : null;
  const selected =
    result.graph.selectedNodeId !== null
      ? (byId.get(result.graph.selectedNodeId) ?? null)
      : null;

  return requested ?? current ?? selected ?? result.graph.nodes[0] ?? null;
}

function gateCount(node: FlowRunNodeDto): number {
  return node.gateSummary.total || node.declaredGateSummary.total;
}

function tokenTotal(result: FlowRunResultDto, node: FlowRunNodeDto): number {
  return result.timeline.entries
    .filter((entry) => entry.nodeId === node.id)
    .reduce((sum, entry) => sum + entry.tokens.total, 0);
}

function hasNodeResultDetails(result: FlowNodeResultDto): boolean {
  return (
    result.flags.failed ||
    result.flags.reworked ||
    result.attempts.length > 0 ||
    result.gates.length > 0 ||
    result.artifacts.length > 0 ||
    result.hitl !== null ||
    result.review !== null ||
    result.readiness !== null
  );
}

function ResultSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      className="rounded-[9px] border border-line bg-ivory p-3"
      data-testid={testId}
    >
      <h4 className="m-0 mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
        {title}
      </h4>
      {children}
    </section>
  );
}

function CompactRows({ children }: { children: ReactNode }): ReactElement {
  return <div className="grid gap-1.5">{children}</div>;
}

function CompactRow({
  title,
  meta,
  tone,
}: {
  title: string;
  meta: string;
  tone?: "danger" | "default";
}): ReactElement {
  return (
    <div
      className={clsx(
        "grid gap-1 rounded-[7px] border px-2.5 py-2 font-mono text-[11px] sm:grid-cols-[minmax(0,1fr)_auto]",
        tone === "danger"
          ? "border-red-200 bg-red-50 text-red-900"
          : "border-line bg-paper text-ink",
      )}
    >
      <span className="min-w-0 truncate font-semibold">{title}</span>
      <span className="text-mute">{meta}</span>
    </div>
  );
}

function FlagBadges({
  result,
  labels,
}: {
  result: FlowNodeResultDto;
  labels: FlowRunCenterLabels;
}): ReactElement | null {
  if (!result.flags.failed && !result.flags.reworked) return null;

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="flow-run-node-flags">
      {result.flags.failed ? (
        <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-red-700">
          {labels.failed}
        </span>
      ) : null}
      {result.flags.reworked ? (
        <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-amber">
          {labels.reworked}
        </span>
      ) : null}
    </div>
  );
}

function AttemptPrompt({
  text,
  labels,
}: {
  text: string;
  labels: FlowRunCenterLabels;
}): ReactElement {
  return (
    <details
      className="group rounded-[7px] border border-line bg-paper"
      data-testid="flow-run-attempt-prompt"
    >
      <summary className="flex cursor-pointer select-none items-center gap-1 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute hover:text-ink">
        <span className="transition-transform group-open:rotate-90">›</span>
        {labels.prompt}
      </summary>
      <div className="border-t border-line">
        <div className="flex justify-end px-2 pt-1.5">
          <button
            className="rounded border border-line bg-ivory px-1.5 py-px font-mono text-[10px] font-semibold text-mute hover:text-ink"
            type="button"
            onClick={() => void navigator.clipboard?.writeText(text)}
          >
            {labels.promptCopy}
          </button>
        </div>
        <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2 pt-1 font-mono text-[11px] leading-[1.5] text-ink">
          {text}
        </pre>
      </div>
    </details>
  );
}

function AttemptRows({
  attempts,
  labels,
}: {
  attempts: FlowNodeAttemptResult[];
  labels: FlowRunCenterLabels;
}): ReactElement | null {
  if (attempts.length === 0) return null;

  return (
    <ResultSection testId="flow-run-node-attempts" title={labels.attempts}>
      <CompactRows>
        {attempts.map((attempt) => (
          <div
            key={`${attempt.attempt}:${attempt.startedAt}`}
            className="grid gap-1"
          >
            <CompactRow
              meta={`${attempt.status} | ${attempt.tokenTotal} ${labels.tokens}`}
              title={`${labels.attempt} ${attempt.attempt}`}
            />
            {attempt.resolvedPrompt ? (
              <AttemptPrompt labels={labels} text={attempt.resolvedPrompt} />
            ) : null}
          </div>
        ))}
      </CompactRows>
    </ResultSection>
  );
}

function GateRows({
  gates,
  labels,
}: {
  gates: FlowNodeGateResult[];
  labels: FlowRunCenterLabels;
}): ReactElement | null {
  if (gates.length === 0) return null;

  return (
    <ResultSection testId="flow-run-node-gates" title={labels.gates}>
      <CompactRows>
        {gates.map((gate) => (
          <CompactRow
            key={`${gate.attempt}:${gate.gateId}:${gate.status}`}
            meta={`${gate.kind} | ${gate.mode} | ${gate.status}`}
            title={gate.gateId}
            tone={gate.status === "failed" ? "danger" : "default"}
          />
        ))}
      </CompactRows>
    </ResultSection>
  );
}

function ArtifactRows({
  artifacts,
  labels,
}: {
  artifacts: FlowNodeArtifactResult[];
  labels: FlowRunCenterLabels;
}): ReactElement | null {
  if (artifacts.length === 0) return null;

  return (
    <ResultSection testId="flow-run-node-artifacts" title={labels.artifacts}>
      <CompactRows>
        {artifacts.map((artifact) => (
          <CompactRow
            key={artifact.id}
            meta={[artifact.kind, artifact.state].filter(Boolean).join(" | ")}
            title={artifact.label}
          />
        ))}
      </CompactRows>
    </ResultSection>
  );
}

function HitlPanel({
  hitl,
  labels,
}: {
  hitl: FlowNodeHitlResult | null;
  labels: FlowRunCenterLabels;
}): ReactElement | null {
  if (hitl === null) return null;

  return (
    <ResultSection testId="flow-run-node-hitl" title={labels.hitl}>
      <CompactRow
        meta={`${hitl.optionCount} ${labels.options}`}
        title={[hitl.kind, hitl.criticality, hitl.assigneeLabel]
          .filter(Boolean)
          .join(" | ")}
      />
    </ResultSection>
  );
}

function ReviewPanel({
  review,
  labels,
}: {
  review: FlowNodeReviewResult | null;
  labels: FlowRunCenterLabels;
}): ReactElement | null {
  if (review === null) return null;

  return (
    <ResultSection testId="flow-run-node-review" title={labels.review}>
      <CompactRow
        meta={`${review.outdatedCount} ${labels.outdatedThreads}`}
        title={`${review.openCount} ${labels.openThreads}`}
      />
    </ResultSection>
  );
}

function ReadinessPanel({
  readiness,
  labels,
}: {
  readiness: FlowNodeReadinessResult | null;
  labels: FlowRunCenterLabels;
}): ReactElement | null {
  if (readiness === null) return null;

  return (
    <ResultSection testId="flow-run-node-readiness" title={labels.readiness}>
      <CompactRow
        meta={readiness.reasons.join(" | ")}
        title={readiness.state}
        tone={readiness.state === "failed" ? "danger" : "default"}
      />
    </ResultSection>
  );
}

function NodeResultDetails({
  result,
  labels,
}: {
  result: FlowNodeResultDto;
  labels: FlowRunCenterLabels;
}): ReactElement | null {
  if (!hasNodeResultDetails(result)) return null;

  return (
    <div className="mt-3 grid gap-2" data-testid="flow-run-node-result">
      <FlagBadges labels={labels} result={result} />
      <AttemptRows attempts={result.attempts} labels={labels} />
      <GateRows gates={result.gates} labels={labels} />
      <ArtifactRows artifacts={result.artifacts} labels={labels} />
      <HitlPanel hitl={result.hitl} labels={labels} />
      <ReviewPanel labels={labels} review={result.review} />
      <ReadinessPanel labels={labels} readiness={result.readiness} />
    </div>
  );
}

export function FlowRunCenter({
  result,
  labels,
  graphView,
}: {
  result: FlowRunResultDto;
  labels: FlowRunCenterLabels;
  graphView?: ReactNode;
}): ReactElement {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const state = parseRunQueryState(searchParams);
  const selected = selectFlowRunNode(result, state.node);
  const selectedResult =
    selected !== null ? buildFlowNodeResult(result, selected) : null;

  if (result.graph.kind !== "ready") {
    return (
      <section
        className="rounded-[14px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute"
        data-testid="flow-run-center-empty"
      >
        {labels.noGraph}
      </section>
    );
  }

  return (
    <section className="grid gap-4" data-testid="flow-run-center">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 font-sans text-[18px] font-bold tracking-[-0.01em] text-ink">
          {labels.title}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Link
            className="rounded-full border border-line bg-ivory px-3 py-2 font-mono text-[11px] font-semibold text-ink hover:border-amber hover:text-amber"
            data-testid="flow-run-fullscreen"
            href={buildRunHref(pathname, query, { flow: "fullscreen" })}
          >
            {labels.fullscreen}
          </Link>
          {result.run.status === "Review" || result.review !== null ? (
            <Link
              className="rounded-full border border-line bg-ivory px-3 py-2 font-mono text-[11px] font-semibold text-ink hover:border-amber hover:text-amber"
              data-testid="flow-run-review-cta"
              href={buildRunHref(pathname, query, { wb: "diff" })}
            >
              {labels.reviewChanges}
            </Link>
          ) : null}
        </div>
      </div>

      {graphView ? (
        <div
          className="overflow-hidden rounded-[10px] border border-line bg-ivory"
          data-testid="flow-run-graph-view"
        >
          {graphView}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(180px,240px)_1fr]">
        <nav
          aria-label={labels.nodes}
          className="rounded-[10px] border border-line bg-paper p-2"
        >
          <div className="mb-2 px-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
            {labels.nodes}
          </div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {result.graph.nodes.map((node) => (
              <li key={node.id}>
                <Link
                  aria-current={selected?.id === node.id ? "step" : undefined}
                  className={clsx(
                    "flex w-full items-center justify-between gap-2 rounded-[7px] px-2 py-1.5 font-mono text-[11px]",
                    selected?.id === node.id
                      ? "bg-ivory text-ink"
                      : "text-ink-2 hover:bg-ivory",
                  )}
                  data-testid="flow-run-node-link"
                  href={buildRunHref(pathname, query, { node: node.id })}
                >
                  <span className="truncate">{node.displayLabel}</span>
                  <NodeStatusIcon
                    label={
                      labels.nodeStatus[node.runtimeStatus] ??
                      node.runtimeStatus
                    }
                    status={node.runtimeStatus}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div
          className="rounded-[10px] border border-line bg-paper p-4"
          data-testid="flow-run-selected-node"
        >
          {selected ? (
            <>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
                    {labels.selectedNode}
                  </div>
                  <h3 className="m-0 mt-1 font-sans text-[16px] font-bold tracking-[-0.01em] text-ink">
                    {selected.displayLabel}
                  </h3>
                </div>
                {selected.current ? (
                  <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-amber">
                    {labels.currentNode}
                  </span>
                ) : null}
              </div>

              <dl className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
                {(
                  [
                    [
                      labels.status,
                      <span
                        key="status-value"
                        className="inline-flex items-center gap-1.5"
                      >
                        <NodeStatusIcon
                          label={
                            labels.nodeStatus[selected.runtimeStatus] ??
                            selected.runtimeStatus
                          }
                          status={selected.runtimeStatus}
                        />
                        <span>
                          {labels.nodeStatus[selected.runtimeStatus] ??
                            selected.runtimeStatus}
                        </span>
                      </span>,
                    ],
                    [labels.attempt, String(selected.attempt)],
                    [labels.gates, String(gateCount(selected))],
                    [labels.tokens, String(tokenTotal(result, selected))],
                  ] as Array<[string, ReactNode]>
                ).map(([label, value]) => (
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

              <NodeTranscriptPanel
                defaultOpen={transcriptPanelDefaultOpen(
                  Boolean(selected.current),
                  isLiveRunStatus(result.run.status),
                )}
                labels={labels.transcript}
                live={isLiveRunStatus(result.run.status)}
                nodeId={selected.id}
                runId={result.run.runId}
              />

              {selectedResult ? (
                <NodeResultDetails labels={labels} result={selectedResult} />
              ) : null}
            </>
          ) : (
            <p className="m-0 text-center font-mono text-[12px] text-mute">
              {labels.noNode}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
