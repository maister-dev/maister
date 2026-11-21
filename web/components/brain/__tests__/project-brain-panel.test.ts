import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

import {
  ProjectBrainPanel,
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
  reviewHistory: "Review history",
  nextSources: "More sources",
  previousSources: "Previous sources",
  filterSources: "Filter sources",
  memoryUnavailable: "Memory unavailable",
};

function render(query = "decision"): string {
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
      projectId: "demo-project",
      pendingReviews: 26,
      sourceQuery: "docs",
      sourcePage: 2,
      hasMoreSources: true,
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

  it("links to scoped proposal review and paged sources without embedding old drafts", () => {
    const html = render();

    expect(html).toContain('data-testid="brain-source-reindex-source-1"');
    expect(html).toContain('data-testid="brain-source-reindex-all"');
    expect(html).toContain(
      "/projects/demo?tab=repo&amp;file=docs%2Fdecisions.md",
    );
    expect(html).toContain("pending 26");
    expect(html).toContain(
      "/knowledge/reviews?kind=brain&amp;projectId=demo-project",
    );
    expect(html).toContain("view=history");
    expect(html).toContain("sourcePage=3");
    expect(html).not.toContain("Brain rule");
  });

  it("shows the search prompt instead of memory results for an empty query", () => {
    const html = render("");

    expect(html).toContain("Search first");
    expect(html).not.toContain("Use task projection");
    expect(html).not.toContain("Brain proposals produce authored drafts.");
  });
});
