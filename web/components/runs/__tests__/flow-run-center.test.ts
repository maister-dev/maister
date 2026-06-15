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
import { describe, expect, it, vi } from "vitest";

let query = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/runs/run-1",
  useSearchParams: () => query,
}));

import {
  FlowRunCenter,
  type FlowRunCenterLabels,
  selectFlowRunNode,
} from "@/components/runs/flow-run-center";
import { buildFlowRunResultDto } from "@/lib/runs/flow-result-dto";

const LABELS: FlowRunCenterLabels = {
  title: "Flow result",
  fullscreen: "Fullscreen",
  reviewChanges: "Review changes",
  nodes: "Nodes",
  selectedNode: "Selected node",
  currentNode: "Current",
  status: "Status",
  attempt: "Attempt",
  attempts: "Attempts",
  gates: "Gates",
  artifacts: "Artifacts",
  hitl: "Needs input",
  review: "Review",
  readiness: "Readiness",
  failed: "Failed",
  reworked: "Reworked",
  openThreads: "open",
  outdatedThreads: "outdated",
  options: "options",
  tokens: "Tokens",
  noGraph: "No graph",
  noNode: "No node",
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

const gateSummary = {
  total: 0,
  blockingTotal: 0,
  advisoryTotal: 0,
  worstBlockingStatus: null,
  failedBlocking: 0,
  staleBlocking: 0,
};

function topology(): GraphTopology {
  return {
    nodes: ["plan", "implement", "review"].map((id) => ({
      id,
      nodeType: "ai_coding",
      label: id,
      displayLabel: id.toUpperCase(),
      nodeTypeLabel: "Agent",
      nodeRole: "agent",
      declaredGateSummary: {
        total: id === "review" ? 1 : 0,
        blocking: id === "review" ? 1 : 0,
        advisory: 0,
        kinds: id === "review" ? ["human_review"] : [],
      },
    })),
    edges: [],
  };
}

function statuses(over: Partial<RunNodeStatuses> = {}): RunNodeStatuses {
  return {
    currentStepId: "implement",
    runStatus: "Running",
    nodes: {
      plan: {
        status: "Succeeded",
        attempt: 1,
        autoRetry: false,
        gates: [],
        rollup: "none",
        gateSummary,
      },
      implement: {
        status: "Running",
        attempt: 2,
        autoRetry: false,
        gates: [],
        rollup: "none",
        gateSummary,
      },
      review: {
        status: "Pending",
        attempt: 0,
        autoRetry: false,
        gates: [],
        rollup: "none",
        gateSummary,
      },
    },
    ...over,
  };
}

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  const nodeId = over.nodeId ?? "implement";

  return {
    nodeAttemptId: `attempt-${nodeId}`,
    nodeId,
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    decision: null,
    reworkFromNode: null,
    acpSessionId: "internal",
    autoRetry: false,
    startedAt: "2026-06-15T09:00:00.000Z",
    endedAt: null,
    durationMs: null,
    tokens: {
      input: 5,
      output: 7,
      cacheRead: 0,
      cacheCreation: 0,
      total: 12,
    },
    gates: [],
    handoff: null,
    ...over,
  };
}

function input(
  over: Partial<BuildFlowRunResultDtoInput> = {},
): BuildFlowRunResultDtoInput {
  const timeline: RunTimeline = {
    entries: [entry({ nodeId: "plan" }), entry({ nodeId: "implement" })],
    assignmentEvents: [],
  };

  return {
    run: {
      runId: "run-1",
      projectId: "project-1",
      projectSlug: "maister",
      taskNumber: 8,
      taskRef: "MAI-8",
      status: "Running",
      startedAt: "2026-06-15T09:00:00.000Z",
      endedAt: null,
      currentStepId: "implement",
      branch: "feature/run",
      agent: "codex",
      runKind: "flow",
      recoverable: false,
      takeoverOwnerUserId: null,
      ttlState: "active",
      effectiveRemovalAt: null,
      archived: false,
      pruned: false,
      baseBranch: "main",
      baseCommit: "abc1234",
      targetBranch: "main",
      prUrl: null,
      prNumber: null,
    },
    graph: {
      topology: topology(),
      layout: {},
      statuses: statuses(),
    },
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
    createElement(FlowRunCenter, {
      result: buildFlowRunResultDto(input(over)),
      labels: LABELS,
      graphView: createElement(
        "div",
        { "data-testid": "graph-child" },
        "Graph",
      ),
    }),
  );
}

describe("FlowRunCenter", () => {
  it("defaults to the current node", () => {
    query = new URLSearchParams();
    const result = buildFlowRunResultDto(input());

    expect(selectFlowRunNode(result, null)?.id).toBe("implement");
    expect(render()).toContain("IMPLEMENT");
    expect(render()).toContain("Current");
  });

  it("selects the node from ?node=", () => {
    query = new URLSearchParams("node=review");
    const html = render();

    expect(html).toContain("REVIEW");
    expect(html).toContain('aria-current="step"');
  });

  it("falls back when ?node= is invalid", () => {
    query = new URLSearchParams("node=missing");
    const result = buildFlowRunResultDto(input());

    expect(selectFlowRunNode(result, "missing")?.id).toBe("implement");
    expect(render()).toContain("IMPLEMENT");
  });

  it("links review changes to the Diff tab while preserving node selection", () => {
    query = new URLSearchParams("node=review");
    const html = render({
      run: {
        ...input().run,
        status: "Review",
      },
    });

    expect(html).toContain('data-testid="flow-run-review-cta"');
    expect(html).toContain('href="/runs/run-1?node=review&amp;wb=diff"');
  });

  it("renders compact result sections for the selected node", () => {
    query = new URLSearchParams("node=implement");
    const html = render({
      timeline: {
        entries: [
          entry({
            nodeAttemptId: "implement-attempt-1",
            nodeId: "implement",
            gates: [
              {
                gateId: "lint",
                kind: "command_check",
                mode: "blocking",
                status: "passed",
                verdict: null,
                stale: false,
                endedAt: "2026-06-15T09:00:04.000Z",
              },
            ],
          }),
        ],
        assignmentEvents: [],
      },
      evidence: {
        nodes: [
          {
            id: "na:implement-attempt-1",
            kind: "node-attempt",
            label: "implement",
            state: "Succeeded",
            meta: {},
          },
          {
            id: "art:patch-1",
            kind: "artifact",
            label: "Patch",
            state: "valid",
            meta: { kind: "patch" },
          },
        ],
        edges: [
          {
            id: "output:patch-1",
            source: "na:implement-attempt-1",
            target: "art:patch-1",
            kind: "output",
          },
        ],
      },
      pendingHitl: {
        hitlRequestId: "hitl-1",
        kind: "human",
        assignmentId: "assignment-1",
        assignmentStatus: "open",
        assignmentActionKind: "human_review",
        assignmentRoleRefs: ["reviewer"],
        assignmentStaleEvidenceSummary: null,
        assigneeLabel: "Reviewer",
        assigneeUserId: "user-1",
        prompt: "Review changes",
        options: [{ optionId: "approve", label: "Approve" }],
        schema: null,
        criticality: "high",
        dirtyResolution: null,
      },
    });

    expect(html).toContain('data-testid="flow-run-node-attempts"');
    expect(html).toContain('data-testid="flow-run-node-gates"');
    expect(html).toContain('data-testid="flow-run-node-artifacts"');
    expect(html).toContain('data-testid="flow-run-node-hitl"');
    expect(html).toContain("lint");
    expect(html).toContain("Patch");
    expect(html).toContain("Reviewer");
  });
});
