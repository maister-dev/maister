import type { ReactElement } from "react";
import type {
  BrainIndexPanelStatus,
  BrainMemorySearchRow,
  BrainProposalReviewRow,
} from "@/lib/brain/ui-queries";
import type { BrainSourceDto } from "@/lib/brain/sources";
import type { BrainSourceRef } from "@/lib/brain/schema";
import type {
  BrainIndexJobReason,
  BrainIndexJobStatus,
} from "@/types/scheduler";

import Link from "next/link";

import {
  BrainProposalReviewActions,
  BrainSourceReindexAction,
  BrainSourceReindexAllAction,
} from "@/components/brain/project-brain-actions";
import { BrainMemorySearch } from "@/components/brain/brain-memory-search";

export interface ProjectBrainPanelLabels {
  title: string;
  memoryTitle: string;
  searchPlaceholder: string;
  searchAction: string;
  emptyMemory: string;
  memorySearchRequired: string;
  tierOwned: string;
  tierIndexed: string;
  confidence: string;
  indexStatusTitle: string;
  indexLatestSourceIndex: string;
  indexIndexedFiles: string;
  indexIndexedChunks: string;
  indexSources: string;
  indexSourcesHint: string;
  indexFailedSources: string;
  indexQueue: string;
  indexQueueHint: string;
  indexLastCompleted: string;
  indexQueued: string;
  indexRunning: string;
  indexFailed: string;
  indexCompleted: string;
  indexConfigureProfile: string;
  indexActiveJobs: string;
  indexNoActiveJobs: string;
  indexOwnedGeneration: string;
  indexProgress: string;
  indexJobStatus: Record<BrainIndexJobStatus, string>;
  indexJobReason: Record<BrainIndexJobReason, string>;
  sourcesTitle: string;
  sourcePath: string;
  sourceKind: string;
  sourceChunker: string;
  sourceStatus: string;
  sourceLastIndexed: string;
  sourceError: string;
  sourceIndexedFiles: string;
  sourceChunks: string;
  sourceEnabled: string;
  sourceDisabled: string;
  sourceNeverIndexed: string;
  reindex: string;
  reindexAll: string;
  proposalsTitle: string;
  pendingBadge: string;
  proposalEvidence: string;
  proposalDraft: string;
  accept: string;
  reject: string;
  rejectReason: string;
  emptyProposals: string;
}

interface ProjectBrainPanelProps {
  slug: string;
  query: string;
  labels: ProjectBrainPanelLabels;
  indexStatus: BrainIndexPanelStatus;
  memory: BrainMemorySearchRow[];
  proposals: BrainProposalReviewRow[];
  sources: BrainSourceDto[];
  canManageSources?: boolean;
  proposalCapabilities?: BrainProposalReviewCapabilities;
}

export interface BrainProposalReviewCapabilities {
  canAcceptCatalog: boolean;
  canAcceptProjection: boolean;
  canReject: boolean;
}

const sectionClass =
  "overflow-hidden rounded-[8px] border border-line bg-paper";
const headingClass = "m-0 text-[14px] font-bold tracking-[-0.01em] text-ink";
const tableHeadClass =
  "border-b border-line bg-ivory px-3 py-2 text-left font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute";
const tableCellClass = "border-b border-line px-3 py-3 align-top text-[12px]";
const badgeClass =
  "inline-flex rounded-full border border-line bg-canvas px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2";

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(value, 1)) * 100)}%`;
}

function formatDate(value: Date | string | null): string {
  if (value === null) return "";

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function errorText(error: Record<string, unknown> | null): string {
  if (error === null) return "—";
  if (typeof error.message === "string") return error.message;

  return JSON.stringify(error);
}

function repoFileHref(slug: string, pointer: BrainSourceRef): string {
  return repoPathHref(slug, pointer.sourcePath, pointer.sourceRange?.startLine);
}

function repoPathHref(slug: string, sourcePath: string, line?: number): string {
  const params = new URLSearchParams({
    tab: "repo",
    file: sourcePath,
  });

  return `/projects/${encodeURIComponent(slug)}?${params.toString()}${
    line ? `#L${line}` : ""
  }`;
}

function pointerLabel(pointer: BrainSourceRef): string {
  const range = pointer.sourceRange;

  if (range?.startLine !== undefined && range.endLine !== undefined) {
    return `${pointer.sourcePath}:${range.startLine}-${range.endLine}`;
  }

  if (range?.startLine !== undefined) {
    return `${pointer.sourcePath}:${range.startLine}`;
  }

  return pointer.sourcePath;
}

function renderPointer(
  slug: string,
  pointer: BrainSourceRef | null,
): ReactElement | null {
  if (pointer === null) return null;

  return (
    <Link
      className="font-mono text-[11px] font-semibold text-accent underline-offset-2 hover:underline"
      href={repoFileHref(slug, pointer)}
    >
      {pointerLabel(pointer)}
    </Link>
  );
}

function draftText(draft: Record<string, unknown>): string {
  return JSON.stringify(draft, null, 2);
}

function canAcceptProposal(
  kind: BrainProposalReviewRow["kind"],
  capabilities: BrainProposalReviewCapabilities,
): boolean {
  if (kind === "rule" || kind === "skill" || kind === "flow") {
    return capabilities.canAcceptCatalog;
  }

  return capabilities.canAcceptProjection;
}

function IndexMetric({
  label,
  sub,
  value,
}: {
  label: string;
  sub?: string;
  value: string | number;
}): ReactElement {
  return (
    <div className="min-w-0 bg-paper px-4 py-3">
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-[18px] font-semibold tracking-[-0.015em] text-ink">
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-mute">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function SourceIndexedFilesCell({
  slug,
  source,
}: {
  slug: string;
  source: BrainSourceDto;
}): ReactElement {
  if (source.indexedFileCount === 0) {
    return <span className="font-mono text-[12px] text-mute">0</span>;
  }

  return (
    <details className="group">
      <summary className="cursor-pointer font-mono text-[12px] font-semibold text-ink underline-offset-2 hover:underline">
        {source.indexedFileCount}
      </summary>
      <div className="mt-2 max-h-[180px] overflow-auto rounded-md border border-line bg-canvas p-2">
        <div className="grid gap-1">
          {source.indexedFilePaths.map((path) => (
            <Link
              key={path}
              className="truncate font-mono text-[11px] text-accent underline-offset-2 hover:underline"
              href={repoPathHref(slug, path)}
            >
              {path}
            </Link>
          ))}
        </div>
      </div>
    </details>
  );
}

function MemorySection({
  slug,
  query,
  labels,
  memory,
}: Pick<
  ProjectBrainPanelProps,
  "slug" | "query" | "labels" | "memory"
>): ReactElement {
  const hasQuery = query.trim().length > 0;

  return (
    <section className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className={headingClass}>{labels.memoryTitle}</h2>
        <BrainMemorySearch
          action={labels.searchAction}
          placeholder={labels.searchPlaceholder}
          query={query}
          slug={slug}
        />
      </div>
      {!hasQuery || memory.length === 0 ? (
        <div className="px-4 py-6 font-mono text-[12px] text-mute">
          {hasQuery ? labels.emptyMemory : labels.memorySearchRequired}
        </div>
      ) : (
        <div className="divide-y divide-line">
          {memory.map((item) => (
            <article key={item.id} className="grid gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={badgeClass}>
                  {item.tier === "owned"
                    ? labels.tierOwned
                    : labels.tierIndexed}
                </span>
                <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                  {item.kind}
                </span>
                <span className="font-mono text-[10.5px] text-mute">
                  {labels.confidence} {formatPercent(item.confidence)}
                </span>
              </div>
              <div className="text-[13px] font-semibold text-ink">
                {item.title}
              </div>
              <p className="m-0 text-[12px] leading-[1.45] text-body">
                {item.preview}
              </p>
              {renderPointer(slug, item.pointer)}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function IndexStatusSection({
  slug,
  labels,
  indexStatus,
}: Pick<
  ProjectBrainPanelProps,
  "slug" | "labels" | "indexStatus"
>): ReactElement {
  const settingsHref = `/projects/${encodeURIComponent(slug)}?tab=settings#project-brain-settings`;

  return (
    <section className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className={headingClass}>{labels.indexStatusTitle}</h2>
        <div className="flex flex-wrap gap-2">
          <span className={badgeClass}>
            {labels.indexQueued} {indexStatus.queued}
          </span>
          <span className={badgeClass}>
            {labels.indexRunning} {indexStatus.running}
          </span>
          <span className={badgeClass}>
            {labels.indexFailed} {indexStatus.failed}
          </span>
          <span className={badgeClass}>
            {labels.indexCompleted} {indexStatus.completed}
          </span>
          <Link
            className={`${badgeClass} text-accent underline-offset-2 hover:underline`}
            href={settingsHref}
          >
            {labels.indexConfigureProfile}
          </Link>
        </div>
      </div>
      <div className="grid gap-3 px-4 py-3">
        <div className="grid gap-px overflow-hidden rounded-[8px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <IndexMetric
            label={labels.indexIndexedFiles}
            value={indexStatus.indexedFileCount}
          />
          <IndexMetric
            label={labels.indexIndexedChunks}
            value={indexStatus.indexedChunkCount}
          />
          <IndexMetric
            label={labels.indexSources}
            sub={labels.indexSourcesHint}
            value={`${indexStatus.enabledSourceCount}/${indexStatus.sourceCount}`}
          />
          <IndexMetric
            label={labels.indexFailedSources}
            value={indexStatus.failedSourceCount}
          />
          <IndexMetric
            label={labels.indexQueue}
            sub={labels.indexQueueHint}
            value={`${indexStatus.queued}/${indexStatus.running}`}
          />
          <IndexMetric
            label={labels.indexLastCompleted}
            value={
              formatDate(indexStatus.latestSourceIndexedAt) ||
              labels.sourceNeverIndexed
            }
          />
        </div>
        <div>
          <div className="mb-2 font-mono text-[10.5px] font-semibold uppercase text-mute">
            {labels.indexActiveJobs}
          </div>
          {indexStatus.activeJobs.length === 0 ? (
            <div className="font-mono text-[12px] text-mute">
              {labels.indexNoActiveJobs}
            </div>
          ) : (
            <div className="divide-y divide-line">
              {indexStatus.activeJobs.map((job) => (
                <div
                  key={job.id}
                  className="grid gap-2 py-2 md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11.5px] text-ink">
                      {job.sourcePath ?? labels.indexOwnedGeneration}
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-mute">
                      {job.id}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 md:justify-end">
                    <span className={badgeClass}>
                      {labels.indexJobStatus[job.status]}
                    </span>
                    <span className={badgeClass}>
                      {labels.indexJobReason[job.reason]}
                    </span>
                    <span className="font-mono text-[10.5px] text-mute">
                      {labels.indexProgress} {job.progress}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SourcesSection({
  slug,
  labels,
  sources,
  canManageSources,
}: Pick<
  ProjectBrainPanelProps,
  "slug" | "labels" | "sources" | "canManageSources"
>): ReactElement {
  return (
    <section className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className={headingClass}>{labels.sourcesTitle}</h2>
        {canManageSources ? (
          <BrainSourceReindexAllAction
            disabled={sources.length === 0}
            label={labels.reindexAll}
            slug={slug}
          />
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th className={tableHeadClass}>{labels.sourcePath}</th>
              <th className={tableHeadClass}>{labels.sourceKind}</th>
              <th className={tableHeadClass}>{labels.sourceChunker}</th>
              <th className={tableHeadClass}>{labels.sourceStatus}</th>
              <th className={tableHeadClass}>{labels.sourceLastIndexed}</th>
              <th className={tableHeadClass}>{labels.sourceError}</th>
              <th className={tableHeadClass}>{labels.sourceIndexedFiles}</th>
              <th className={tableHeadClass}>{labels.sourceChunks}</th>
              <th className={tableHeadClass} />
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td className={`${tableCellClass} font-mono`}>{source.path}</td>
                <td className={tableCellClass}>{source.kind}</td>
                <td className={tableCellClass}>{source.chunkerId}</td>
                <td className={tableCellClass}>
                  {source.enabled
                    ? labels.sourceEnabled
                    : labels.sourceDisabled}
                </td>
                <td className={tableCellClass}>
                  {formatDate(source.lastIndexedAt) ||
                    labels.sourceNeverIndexed}
                </td>
                <td className={tableCellClass}>
                  {errorText(source.lastError)}
                </td>
                <td className={tableCellClass}>
                  <SourceIndexedFilesCell slug={slug} source={source} />
                </td>
                <td className={tableCellClass}>{source.chunkCount}</td>
                <td className={tableCellClass}>
                  {canManageSources ? (
                    <BrainSourceReindexAction
                      label={labels.reindex}
                      slug={slug}
                      sourceId={source.id}
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProposalsSection({
  slug,
  labels,
  proposals,
  proposalCapabilities,
}: {
  slug: string;
  labels: ProjectBrainPanelLabels;
  proposals: BrainProposalReviewRow[];
  proposalCapabilities: BrainProposalReviewCapabilities;
}): ReactElement {
  return (
    <section className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className={headingClass}>{labels.proposalsTitle}</h2>
        <span className={badgeClass}>
          {labels.pendingBadge}{" "}
          {proposals.filter((proposal) => proposal.status === "pending").length}
        </span>
      </div>
      {proposals.length === 0 ? (
        <div className="px-4 py-6 font-mono text-[12px] text-mute">
          {labels.emptyProposals}
        </div>
      ) : (
        <div className="divide-y divide-line">
          {proposals.map((proposal) => {
            const canAccept = canAcceptProposal(
              proposal.kind,
              proposalCapabilities,
            );
            const canReject = proposalCapabilities.canReject;

            return (
              <article
                key={proposal.id}
                className="grid gap-3 px-4 py-4 lg:grid-cols-[1fr_auto]"
              >
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={badgeClass}>{proposal.kind}</span>
                    <span className="font-mono text-[10.5px] text-mute">
                      {proposal.status} · {proposal.blastRadius} ·{" "}
                      {proposal.autonomyDecision}
                    </span>
                  </div>
                  <div className="mb-2">
                    <div className="mb-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                      {labels.proposalEvidence}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {proposal.evidence.map((item) => (
                        <span key={item.id} className="text-[12px]">
                          {renderPointer(slug, item.pointer) ?? item.title}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                      {labels.proposalDraft}
                    </div>
                    <pre className="m-0 max-h-[220px] overflow-auto rounded-md border border-line bg-canvas p-3 font-mono text-[11px] leading-[1.45] text-ink">
                      {draftText(proposal.draft)}
                    </pre>
                  </div>
                </div>
                {proposal.status === "pending" && (canAccept || canReject) ? (
                  <BrainProposalReviewActions
                    canAccept={canAccept}
                    canReject={canReject}
                    labels={{
                      accept: labels.accept,
                      reject: labels.reject,
                      rejectReason: labels.rejectReason,
                    }}
                    proposalId={proposal.id}
                    slug={slug}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ProjectBrainPanel({
  slug,
  query,
  labels,
  indexStatus,
  memory,
  proposals,
  sources,
  canManageSources = true,
  proposalCapabilities = {
    canAcceptCatalog: true,
    canAcceptProjection: true,
    canReject: true,
  },
}: ProjectBrainPanelProps): ReactElement {
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {labels.title}
        </h2>
      </div>
      <MemorySection
        labels={labels}
        memory={memory}
        query={query}
        slug={slug}
      />
      <IndexStatusSection
        indexStatus={indexStatus}
        labels={labels}
        slug={slug}
      />
      <SourcesSection
        canManageSources={canManageSources}
        labels={labels}
        slug={slug}
        sources={sources}
      />
      <ProposalsSection
        labels={labels}
        proposalCapabilities={proposalCapabilities}
        proposals={proposals}
        slug={slug}
      />
    </section>
  );
}
