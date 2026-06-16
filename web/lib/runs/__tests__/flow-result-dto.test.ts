import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type {
  RunCostSummary,
  RunTimeline,
  TimelineEntry,
} from "@/lib/queries/run";
import type { RunNodeStatuses } from "@/lib/queries/run-node-status";
import type {
  BuildFlowRunResultDtoInput,
  FlowResultReviewInput,
} from "@/lib/runs/flow-result-dto";

import { describe, expect, it } from "vitest";

import { buildFlowRunResultDto } from "@/lib/runs/flow-result-dto";

const NOW_MS = Date.parse("2026-06-15T10:00:00.000Z");

const gateSummary = {
  total: 0,
  blockingTotal: 0,
  advisoryTotal: 0,
  worstBlockingStatus: null,
  failedBlocking: 0,
  staleBlocking: 0,
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

const deliveryPolicy = {
  strategy: "merge",
  push: "never",
  trigger: "manual",
  targetBranch: "main",
} as const;

function topology(ids: string[]): GraphTopology {
  return {
    nodes: ids.map((id) => ({
      id,
      nodeType: "ai_coding",
      label: id,
      displayLabel: id.toUpperCase(),
      nodeTypeLabel: "Agent",
      nodeRole: "agent",
      declaredGateSummary: {
        total: 0,
        blocking: 0,
        advisory: 0,
        kinds: [],
      },
    })),
    edges: ids.slice(0, -1).map((id, index) => ({
      id: `${id}:success`,
      source: id,
      target: ids[index + 1],
      outcome: "success",
      displayLabel: "Success",
      edgeRole: "success",
    })),
  };
}

function status(over: Partial<RunNodeStatuses["nodes"][string]> = {}) {
  return {
    status: "Succeeded",
    attempt: 1,
    autoRetry: false,
    gates: [],
    rollup: "none",
    gateSummary,
    ...over,
  };
}

function graph(
  ids: string[],
  over: Partial<RunNodeStatuses> = {},
): BuildFlowRunResultDtoInput["graph"] {
  return {
    topology: topology(ids),
    layout: Object.fromEntries(
      ids.map((id, index) => [id, { x: index * 160, y: 0 }]),
    ),
    statuses: {
      currentStepId: null,
      runStatus: "Running",
      nodes: Object.fromEntries(ids.map((id) => [id, status()])),
      ...over,
    },
  };
}

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  const nodeId = over.nodeId ?? "plan";

  return {
    nodeAttemptId: `attempt-${nodeId}`,
    nodeId,
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    decision: null,
    reworkFromNode: null,
    resolvedPrompt: null,
    acpSessionId: "session-internal",
    autoRetry: false,
    startedAt: "2026-06-15T09:00:00.000Z",
    endedAt: "2026-06-15T09:00:01.000Z",
    durationMs: 1000,
    tokens: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreation: 4,
      total: 10,
    },
    gates: [],
    handoff: null,
    ...over,
  };
}

function timeline(entries: TimelineEntry[]): RunTimeline {
  return { entries, assignmentEvents: [] };
}

function baseInput(
  over: Partial<BuildFlowRunResultDtoInput> = {},
): BuildFlowRunResultDtoInput {
  return {
    run: {
      runId: "run-1",
      projectId: "project-1",
      projectSlug: "maister",
      taskNumber: 7,
      taskRef: "MAI-7",
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
    graph: graph("plan implement review".split(" "), {
      currentStepId: "implement",
      nodes: {
        plan: status({ status: "Succeeded" }),
        implement: status({ status: "Running", attempt: 2 }),
        review: status({ status: "Pending", attempt: 0 }),
      },
    }),
    timeline: timeline([entry({ nodeId: "plan" })]),
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
    nowMs: NOW_MS,
    ...over,
  };
}

function legacyReview(): FlowResultReviewInput {
  return {
    baseBranch: null,
    baseCommit: null,
    targetBranch: null,
    reviewedTargetCommit: null,
    promotionMode: "merge",
    deliveryPolicy,
    diff: {
      files: [],
      truncated: false,
    },
    driftDetected: false,
    legacyNeedsRelaunch: true,
  };
}

describe("buildFlowRunResultDto", () => {
  it("maps the current graph node and strips internal session ids", () => {
    const dto = buildFlowRunResultDto(baseInput());

    expect(dto.graph.kind).toBe("ready");
    expect(dto.graph.currentNodeId).toBe("implement");
    expect(dto.graph.selectedNodeId).toBe("implement");
    expect(
      dto.graph.nodes.find((node) => node.id === "implement"),
    ).toMatchObject({
      runtimeStatus: "Running",
      attempt: 2,
      current: true,
      selected: true,
    });
    expect(dto.timeline.entries[0]).not.toHaveProperty("acpSessionId");
  });

  it("selects the latest timeline node for terminal runs without currentStepId", () => {
    const dto = buildFlowRunResultDto(
      baseInput({
        run: {
          ...baseInput().run,
          status: "Done",
          endedAt: "2026-06-15T09:10:00.000Z",
          currentStepId: null,
        },
        graph: graph("plan implement review".split(" "), {
          runStatus: "Done",
          currentStepId: null,
        }),
        timeline: timeline([
          entry({ nodeId: "plan" }),
          entry({ nodeId: "implement" }),
          entry({ nodeId: "review" }),
        ]),
      }),
    );

    expect(dto.graph.kind).toBe("ready");
    expect(dto.graph.currentNodeId).toBeNull();
    expect(dto.graph.selectedNodeId).toBe("review");
    expect(dto.graph.nodes.find((node) => node.id === "review")).toMatchObject({
      current: false,
      selected: true,
    });
  });

  it("returns a missing-manifest graph DTO when no pinned topology is available", () => {
    const dto = buildFlowRunResultDto(
      baseInput({
        graph: null,
        timeline: timeline([]),
      }),
    );

    expect(dto.graph).toEqual({
      kind: "missing-manifest",
      nodeCount: 0,
      currentNodeId: null,
      selectedNodeId: null,
      nodes: [],
      edges: [],
    });
  });

  it("projects legacy review diff fallback as explicit review state", () => {
    const dto = buildFlowRunResultDto(baseInput({ review: legacyReview() }));

    expect(dto.review).toMatchObject({
      targetBranch: null,
      reviewedTargetCommit: null,
      legacyNeedsRelaunch: true,
      diff: { fileCount: 0, truncated: false },
    });
    expect(dto.degradations).toContain("review-diff-fallback");
  });
});
