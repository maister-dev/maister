import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type {
  RunCostSummary,
  RunTimeline,
  TimelineEntry,
} from "@/lib/queries/run";
import type { RunNodeStatuses } from "@/lib/queries/run-node-status";
import type { BuildFlowRunResultDtoInput } from "@/lib/runs/flow-result-dto";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgentRunCenter,
  type AgentRunCenterLabels,
  shouldRenderAgentRunCenter,
} from "@/components/runs/agent-run-center";
import { buildFlowRunResultDto } from "@/lib/runs/flow-result-dto";

const LABELS: AgentRunCenterLabels = {
  title: "Agent run",
  subtitle: "Standalone session",
  status: "Status",
  runner: "Runner",
  latestActivity: "Latest activity",
  noActivity: "No activity yet",
  evidence: "Evidence",
  terminal: "Terminal",
  reviewChanges: "Review changes",
  openDiff: "Open diff",
};

const cost: RunCostSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  resumeTokens: 0,
  totalTokens: 0,
  byModel: {},
};

function entry(over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    nodeAttemptId: "attempt-1",
    nodeId: "triage",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    decision: null,
    reworkFromNode: null,
    acpSessionId: "internal-session",
    autoRetry: false,
    startedAt: "2026-06-15T09:00:00.000Z",
    endedAt: null,
    durationMs: null,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
    },
    gates: [],
    handoff: null,
    ...over,
  };
}

function graph(): BuildFlowRunResultDtoInput["graph"] {
  const topology: GraphTopology = {
    nodes: [],
    edges: [],
  };
  const statuses: RunNodeStatuses = {
    currentStepId: null,
    runStatus: "Running",
    nodes: {},
  };

  return { topology, layout: {}, statuses };
}

function input(
  over: Partial<BuildFlowRunResultDtoInput> = {},
): BuildFlowRunResultDtoInput {
  const timeline: RunTimeline = { entries: [entry()], assignmentEvents: [] };

  return {
    run: {
      runId: "run-1",
      projectId: "project-1",
      projectSlug: "maister",
      taskNumber: null,
      taskRef: null,
      status: "Running",
      startedAt: "2026-06-15T09:00:00.000Z",
      endedAt: null,
      currentStepId: null,
      branch: "agent/triage",
      agent: "codex",
      runKind: "agent",
      recoverable: false,
      takeoverOwnerUserId: null,
      ttlState: "active",
      effectiveRemovalAt: null,
      archived: false,
      pruned: false,
      baseBranch: "main",
      baseCommit: null,
      targetBranch: "main",
      prUrl: null,
      prNumber: null,
    },
    graph: null,
    timeline,
    evidence: { nodes: [], edges: [] },
    readiness: null,
    cost,
    settings: null,
    pendingHitl: null,
    dirtySummary: null,
    review: null,
    reviewGate: {
      active: false,
      canComment: false,
      threadCounts: null,
    },
    capabilityNodes: [],
    resolvedCapabilitySet: null,
    nowMs: Date.parse("2026-06-15T10:00:00.000Z"),
    ...over,
  };
}

function render(over: Partial<BuildFlowRunResultDtoInput> = {}): string {
  return renderToStaticMarkup(
    createElement(AgentRunCenter, {
      result: buildFlowRunResultDto(input(over)),
      labels: LABELS,
    }),
  );
}

describe("AgentRunCenter", () => {
  it("renders an agent run with no pinned Flow manifest", () => {
    const result = buildFlowRunResultDto(input());
    const html = render();

    expect(shouldRenderAgentRunCenter(result)).toBe(true);
    expect(html).toContain('data-testid="agent-run-center"');
    expect(html).toContain("Agent run");
    expect(html).toContain("Running");
    expect(html).toContain("triage #1");
  });

  it("links Review agent runs to the shared workbench diff", () => {
    const html = render({
      run: {
        ...input().run,
        status: "Review",
      },
      review: {
        baseBranch: "main",
        baseCommit: "abc1234",
        targetBranch: "main",
        reviewedTargetCommit: "def5678",
        promotionMode: "merge",
        deliveryPolicy: {
          strategy: "merge",
          push: "never",
          trigger: "manual",
          targetBranch: "main",
        },
        diff: {
          files: ["README.md"],
          truncated: false,
        },
        driftDetected: false,
        legacyNeedsRelaunch: false,
      },
    });

    expect(html).toContain('data-testid="agent-run-review-cta"');
    expect(html).toContain('href="/runs/run-1?wb=diff"');
  });

  it("marks terminal agent runs without rendering scratch conversation controls", () => {
    const html = render({
      run: {
        ...input().run,
        status: "Done",
        endedAt: "2026-06-15T09:05:00.000Z",
      },
      timeline: {
        entries: [entry({ status: "Succeeded" })],
        assignmentEvents: [],
      },
    });

    expect(html).toContain('data-testid="agent-run-terminal"');
    expect(html).toContain("Done");
    expect(html).not.toContain("textarea");
  });

  it("ignores node query state by keeping center links node-free", () => {
    const html = render({
      graph: graph(),
      run: {
        ...input().run,
        status: "Review",
        currentStepId: "not-a-flow-node",
      },
    });

    expect(html).toContain('href="/runs/run-1?wb=diff"');
    expect(html).not.toContain("node=");
  });
});
