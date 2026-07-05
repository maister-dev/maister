import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ProjectBrainPanel,
  type BrainProposalReviewCapabilities,
  type ProjectBrainPanelLabels,
} from "@/components/brain/project-brain-panel";

const labels: ProjectBrainPanelLabels = {
  title: "Project Brain",
  memoryTitle: "Memory",
  searchPlaceholder: "Search memory",
  searchAction: "Search",
  emptyMemory: "No memory",
  memorySearchRequired: "Search first",
  tierOwned: "owned",
  tierIndexed: "indexed",
  confidence: "confidence",
  indexStatusTitle: "Index status",
  indexLatestSourceIndex: "Latest source index",
  indexIndexedFiles: "Indexed files",
  indexIndexedChunks: "Chunks",
  indexSources: "Sources",
  indexSourcesHint: "enabled / total",
  indexFailedSources: "Failed sources",
  indexQueue: "Queue",
  indexQueueHint: "queued / running",
  indexLastCompleted: "Last completed",
  indexQueued: "Queued",
  indexRunning: "Running",
  indexFailed: "Failed",
  indexCompleted: "Completed",
  indexConfigureProfile: "Configure profile",
  indexActiveJobs: "Active jobs",
  indexNoActiveJobs: "No active jobs",
  indexOwnedGeneration: "Owned generation",
  indexProgress: "progress",
  indexJobStatus: {
    queued: "queued",
    running: "running",
    completed: "completed",
    failed: "failed",
  },
  indexJobReason: {
    model_switch: "model switch",
    manual: "manual",
    event: "event",
    chunker_upgrade: "chunker upgrade",
  },
  sourcesTitle: "Sources",
  sourcePath: "Path",
  sourceKind: "Kind",
  sourceChunker: "Chunker",
  sourceStatus: "Status",
  sourceLastIndexed: "Last indexed",
  sourceError: "Error",
  sourceIndexedFiles: "Indexed files",
  sourceChunks: "Chunks",
  sourceEnabled: "enabled",
  sourceDisabled: "disabled",
  sourceNeverIndexed: "never",
  reindex: "Reindex",
  reindexAll: "Index all",
  proposalsTitle: "Proposals",
  pendingBadge: "pending",
  proposalEvidence: "Evidence",
  proposalDraft: "Draft",
  accept: "Accept",
  reject: "Reject",
  rejectReason: "Reason",
  emptyProposals: "No proposals",
};

const fullProposalCapabilities: BrainProposalReviewCapabilities = {
  canAcceptCatalog: true,
  canAcceptProjection: true,
  canReject: true,
};

function render(
  proposalCapabilities: BrainProposalReviewCapabilities = fullProposalCapabilities,
  query = "decision",
): string {
  return renderToStaticMarkup(
    createElement(ProjectBrainPanel, {
      slug: "demo",
      query,
      labels,
      indexStatus: {
        activeJobs: [
          {
            id: "job-1",
            sourceId: "source-1",
            sourcePath: "docs/decisions.md",
            reason: "manual",
            status: "queued",
            progress: 0,
            createdAt: "2026-07-04T00:00:00.000Z",
          },
        ],
        completed: 2,
        failed: 0,
        failedSourceCount: 0,
        enabledSourceCount: 1,
        indexedChunkCount: 3,
        indexedFileCount: 1,
        latestSourceIndexedAt: "2026-07-03T00:00:00.000Z",
        queued: 1,
        running: 0,
        sourceCount: 1,
      },
      memory: [
        {
          id: "item-1",
          tier: "owned",
          kind: "decision",
          title: "Use task projection",
          preview: "Projection goes through normal task promotion.",
          confidence: 0.73,
          pointer: null,
        },
        {
          id: "chunk-1",
          tier: "indexed",
          kind: "markdown",
          title: "ADR-128",
          preview: "Brain proposals produce authored drafts.",
          confidence: 1,
          pointer: {
            sourcePath: "docs/decisions.md",
            stableId: "adr-128",
            sourceRange: { startLine: 10, endLine: 18 },
          },
        },
      ],
      proposals: [
        {
          id: "proposal-1",
          kind: "rule",
          status: "pending",
          blastRadius: "low",
          autonomyDecision: "manual",
          draft: { slug: "brain-rule", title: "Brain rule" },
          evidence: [
            {
              id: "item-1",
              title: "Use task projection",
              pointer: { sourcePath: "docs/decisions.md" },
            },
          ],
          createdAt: "2026-07-03T00:00:00.000Z",
        },
        {
          id: "proposal-2",
          kind: "state",
          status: "pending",
          blastRadius: "low",
          autonomyDecision: "manual",
          draft: { title: "Document Brain state" },
          evidence: [
            {
              id: "item-2",
              title: "Brain source state",
              pointer: { sourcePath: "docs/system-analytics/project-brain.md" },
            },
          ],
          createdAt: "2026-07-03T00:00:00.000Z",
        },
      ],
      proposalCapabilities,
      sources: [
        {
          id: "source-1",
          kind: "markdown",
          path: "docs/decisions.md",
          chunkerId: "markdown",
          chunkerVersion: "1",
          enabled: true,
          sourceHash: "abc",
          lastIndexedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
          indexedFileCount: 1,
          indexedFilePaths: ["docs/decisions.md"],
          chunkCount: 3,
        },
      ],
    }),
  );
}

describe("ProjectBrainPanel", () => {
  it("renders memory search with tier/confidence and existing repo file links", () => {
    const html = render();

    expect(html).toContain('data-testid="brain-memory-search"');
    expect(html).toContain("owned");
    expect(html).toContain("indexed");
    expect(html).toContain("73%");
    expect(html).toContain("100%");
    expect(html).toContain("Index status");
    expect(html).toContain("Indexed files");
    expect(html).toContain("Last completed");
    expect(html).toContain("Configure profile");
    expect(html).toContain(
      "/projects/demo?tab=settings#project-brain-settings",
    );
    expect(html).toContain("job-1");
    expect(html).toContain(
      "/projects/demo?tab=repo&amp;file=docs%2Fdecisions.md#L10",
    );
  });

  it("renders source index actions and proposal review actions without auto_publish", () => {
    const html = render();

    expect(html).toContain('data-testid="brain-source-reindex-source-1"');
    expect(html).toContain('data-testid="brain-source-reindex-all"');
    expect(html).toContain(
      "/projects/demo?tab=repo&amp;file=docs%2Fdecisions.md",
    );
    expect(html).toContain('data-testid="brain-proposal-accept-proposal-1"');
    expect(html).toContain('data-testid="brain-proposal-reject-proposal-1"');
    expect(html).toContain('data-testid="brain-proposal-accept-proposal-2"');
    expect(html).toContain('data-testid="brain-proposal-reject-proposal-2"');
    expect(html).toContain("Reason");
    expect(html).not.toContain("auto_publish");
  });

  it("hides catalog accept actions when the user can only reject and accept projections", () => {
    const html = render({
      canAcceptCatalog: false,
      canAcceptProjection: true,
      canReject: true,
    });

    expect(html).not.toContain(
      'data-testid="brain-proposal-accept-proposal-1"',
    );
    expect(html).toContain('data-testid="brain-proposal-reject-proposal-1"');
    expect(html).toContain('data-testid="brain-proposal-accept-proposal-2"');
    expect(html).toContain('data-testid="brain-proposal-reject-proposal-2"');
  });

  it("shows the search prompt instead of memory results for an empty query", () => {
    const html = render(fullProposalCapabilities, "");

    expect(html).toContain("Search first");
    expect(html).not.toContain("Use task projection");
    expect(html).not.toContain("Brain proposals produce authored drafts.");
  });
});
