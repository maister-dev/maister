import type { GraphTopology } from "@/lib/queries/flow-graph-view";
import type {
  RunCostSummary,
  RunTimeline,
  TimelineEntry,
  TimelineGate,
} from "@/lib/queries/run";
import type { RunNodeStatuses } from "@/lib/queries/run-node-status";
import type {
  BuildFlowRunResultDtoInput,
  FlowRunNodeDto,
  FlowRunResultDto,
} from "@/lib/runs/flow-result-dto";

import { describe, expect, it } from "vitest";

import { buildFlowRunResultDto } from "@/lib/runs/flow-result-dto";
import { buildFlowNodeResult } from "@/lib/runs/flow-node-result";

const NOW_MS = Date.parse("2026-06-15T10:00:00.000Z");

const cost: RunCostSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  resumeTokens: 0,
  totalTokens: 0,
  byModel: {},
};

const emptyGateSummary = {
  total: 0,
  blockingTotal: 0,
  advisoryTotal: 0,
  worstBlockingStatus: null,
  failedBlocking: 0,
  staleBlocking: 0,
};

const deliveryPolicy = {
  strategy: "merge",
  push: "never",
  trigger: "manual",
  targetBranch: "main",
} as const;

function topology(): GraphTopology {
  return {
    nodes: ["plan", "implement", "review"].map((id) => ({
      id,
      nodeType: id === "review" ? "human" : "ai_coding",
      label: id,
      displayLabel: id.toUpperCase(),
      nodeTypeLabel: id === "review" ? "Human" : "Agent",
      nodeRole: id === "review" ? "human" : "agent",
      declaredGateSummary: {
        total: id === "implement" ? 1 : 0,
        blocking: id === "implement" ? 1 : 0,
        advisory: 0,
        kinds: id === "implement" ? ["command_check"] : [],
      },
    })),
    edges: [],
  };
}

function status(
  over: Partial<RunNodeStatuses["nodes"][string]> = {},
): RunNodeStatuses["nodes"][string] {
  return {
    status: "Pending",
    attempt: 0,
    autoRetry: false,
    gates: [],
    rollup: "none",
    gateSummary: emptyGateSummary,
    ...over,
  };
}

function statuses(over: Partial<RunNodeStatuses> = {}): RunNodeStatuses {
  return {
    currentStepId: "implement",
    runStatus: "Running",
    nodes: {
      plan: status({ status: "Succeeded", attempt: 1 }),
      implement: status({ status: "Running", attempt: 1 }),
      review: status(),
    },
    ...over,
  };
}

function gate(over: Partial<TimelineGate> = {}): TimelineGate {
  return {
    gateId: "unit",
    kind: "command_check",
    mode: "blocking",
    status: "passed",
    verdict: null,
    stale: false,
    endedAt: "2026-06-15T09:00:02.000Z",
    ...over,
  };
}

function entry(over: Partial<TimelineEntry> = {}): TimelineEntry {
  const nodeId = over.nodeId ?? "implement";

  return {
    nodeAttemptId: `attempt-${nodeId}`,
    nodeId,
    nodeType: nodeId === "review" ? "human" : "ai_coding",
    attempt: 1,
    status: "Succeeded",
    decision: null,
    reworkFromNode: null,
    acpSessionId: "internal-session",
    autoRetry: false,
    startedAt: "2026-06-15T09:00:00.000Z",
    endedAt: "2026-06-15T09:00:03.000Z",
    durationMs: 3000,
    tokens: {
      input: 3,
      output: 4,
      cacheRead: 1,
      cacheCreation: 2,
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

function input(
  over: Partial<BuildFlowRunResultDtoInput> = {},
): BuildFlowRunResultDtoInput {
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
    timeline: timeline([entry({ nodeId: "implement" })]),
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

function dto(over: Partial<BuildFlowRunResultDtoInput> = {}): FlowRunResultDto {
  return buildFlowRunResultDto(input(over));
}

function node(result: FlowRunResultDto, nodeId: string): FlowRunNodeDto {
  if (result.graph.kind !== "ready") {
    throw new Error("expected ready graph");
  }

  const found = result.graph.nodes.find((candidate) => candidate.id === nodeId);

  if (!found) {
    throw new Error(`expected graph node ${nodeId}`);
  }

  return found;
}

describe("buildFlowNodeResult", () => {
  it("projects attempts, gates, and output artifacts for the selected node", () => {
    const result = dto({
      timeline: timeline([
        entry({
          nodeAttemptId: "implement-attempt-1",
          nodeId: "implement",
          gates: [gate({ gateId: "lint" })],
        }),
      ]),
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
    });

    const nodeResult = buildFlowNodeResult(result, node(result, "implement"));

    expect(nodeResult.attempts).toMatchObject([
      {
        attempt: 1,
        status: "Succeeded",
        durationMs: 3000,
        tokenTotal: 10,
      },
    ]);
    expect(nodeResult.gates).toMatchObject([
      {
        attempt: 1,
        gateId: "lint",
        kind: "command_check",
        mode: "blocking",
        status: "passed",
        stale: false,
      },
    ]);
    expect(nodeResult.artifacts).toEqual([
      {
        id: "art:patch-1",
        label: "Patch",
        state: "valid",
        kind: "patch",
      },
    ]);
  });

  it("flags reworked nodes from timeline outcomes", () => {
    const result = dto({
      run: {
        ...input().run,
        currentStepId: "review",
      },
      graph: {
        topology: topology(),
        layout: {},
        statuses: statuses({
          currentStepId: "review",
          nodes: {
            plan: status({ status: "Succeeded", attempt: 1 }),
            implement: status({ status: "Succeeded", attempt: 1 }),
            review: status({ status: "Reworked", attempt: 1 }),
          },
        }),
      },
      timeline: timeline([
        entry({
          nodeId: "review",
          status: "Reworked",
          decision: "rework",
          reworkFromNode: "implement",
        }),
      ]),
    });

    expect(
      buildFlowNodeResult(result, node(result, "review")).flags.reworked,
    ).toBe(true);
  });

  it("projects pending HITL only for the current node", () => {
    const result = dto({
      pendingHitl: {
        hitlRequestId: "hitl-1",
        kind: "human",
        assignmentId: "assignment-1",
        assignmentStatus: "open",
        assignmentActionKind: "human_review",
        assignmentRoleRefs: ["reviewer"],
        assignmentStaleEvidenceSummary: { count: 2 },
        assigneeLabel: "Reviewer",
        assigneeUserId: "user-1",
        prompt: "Review changes",
        options: [
          { optionId: "approve", label: "Approve" },
          { optionId: "rework", label: "Request changes" },
        ],
        schema: null,
        criticality: "high",
        dirtyResolution: "proceed",
      },
    });

    expect(buildFlowNodeResult(result, node(result, "implement")).hitl).toEqual(
      {
        hitlRequestId: "hitl-1",
        kind: "human",
        criticality: "high",
        assigneeLabel: "Reviewer",
        optionCount: 2,
        dirtyResolution: "proceed",
      },
    );
    expect(buildFlowNodeResult(result, node(result, "plan")).hitl).toBeNull();
  });

  it("projects review and readiness for the review node", () => {
    const result = dto({
      run: {
        ...input().run,
        status: "Review",
        currentStepId: "review",
      },
      graph: {
        topology: topology(),
        layout: {},
        statuses: statuses({
          currentStepId: "review",
          runStatus: "Review",
          nodes: {
            plan: status({ status: "Succeeded", attempt: 1 }),
            implement: status({ status: "Succeeded", attempt: 1 }),
            review: status({ status: "Running", attempt: 1 }),
          },
        }),
      },
      review: {
        baseBranch: "main",
        baseCommit: "abc1234",
        targetBranch: "feature/run",
        reviewedTargetCommit: null,
        promotionMode: "merge",
        deliveryPolicy,
        diff: {
          files: [],
          truncated: false,
        },
        driftDetected: false,
        legacyNeedsRelaunch: false,
      },
      reviewGate: {
        active: true,
        canComment: true,
        threadCounts: { openCount: 3, outdatedCount: 1 },
      },
      readiness: {
        readiness: "blocked",
        externalGates: [],
        requiredArtifacts: [],
        reasons: ["review required"],
      },
      timeline: timeline([entry({ nodeId: "review", status: "Running" })]),
    });

    const nodeResult = buildFlowNodeResult(result, node(result, "review"));

    expect(nodeResult.review).toEqual({
      openCount: 3,
      outdatedCount: 1,
    });
    expect(nodeResult.readiness).toEqual({
      state: "blocked",
      reasons: ["review required"],
    });
  });

  it("flags failed nodes and omits artifact sections without outputs", () => {
    const result = dto({
      graph: {
        topology: topology(),
        layout: {},
        statuses: statuses({
          nodes: {
            plan: status({ status: "Succeeded", attempt: 1 }),
            implement: status({ status: "Failed", attempt: 1 }),
            review: status(),
          },
        }),
      },
      timeline: timeline([
        entry({
          nodeId: "implement",
          status: "Failed",
          gates: [gate({ gateId: "test", status: "failed" })],
        }),
      ]),
    });

    const nodeResult = buildFlowNodeResult(result, node(result, "implement"));

    expect(nodeResult.flags.failed).toBe(true);
    expect(nodeResult.artifacts).toEqual([]);
  });
});
