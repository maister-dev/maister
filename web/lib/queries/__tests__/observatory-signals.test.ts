import { describe, expect, it } from "vitest";

import {
  clusterGateSignals,
  clusterRetrySignals,
  clusterReworkSignals,
  normalizeSignalText,
  rankSignals,
  redactSignalText,
} from "@/lib/queries/observatory-signals";

describe("observatory signal harvesting", () => {
  it("normalizes and redacts optional examples before clustering", () => {
    expect(normalizeSignalText("  Fix   lint\nagain  ")).toBe("fix lint again");
    expect(
      redactSignalText("API_TOKEN=sk_live_12345 and password=secret"),
    ).toBe("API_TOKEN=[redacted] and password=[redacted]");
    expect(normalizeSignalText("ok")).toBeNull();
  });

  it("redacts bare tokens, hex digests, AWS keys, and JWTs in free text", () => {
    expect(redactSignalText("leaked sk_live_abcdefgh1234 here")).toBe(
      "leaked [redacted] here",
    );
    expect(redactSignalText("pushed with ghp_ABCDEFGH012345 token")).toBe(
      "pushed with [redacted] token",
    );
    expect(
      redactSignalText("digest d41d8cd98f00b204e9800998ecf8427e mismatch"),
    ).toBe("digest [redacted] mismatch");
    expect(redactSignalText("aws AKIAIOSFODNN7EXAMPLE rejected")).toBe(
      "aws [redacted] rejected",
    );
    expect(
      redactSignalText(
        "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.s3cr3tSig denied",
      ),
    ).toBe("auth [redacted] denied");
  });

  it("clusters structured rework metadata without depending on free text", () => {
    const clusters = clusterReworkSignals([
      {
        id: "hitl-1",
        projectId: "project-a",
        runId: "run-1",
        flowId: "flow-a",
        stepId: "review",
        decision: "rework",
        reworkTarget: "implement",
        workspacePolicy: "keep",
      },
      {
        id: "hitl-2",
        projectId: "project-a",
        runId: "run-2",
        flowId: "flow-a",
        stepId: "review",
        decision: "rework",
        reworkTarget: "implement",
        workspacePolicy: "keep",
      },
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      kind: "rework",
      occurrenceCount: 2,
      affectedRunCount: 2,
      affectedProjectCount: 1,
      criticality: null,
      humanConfidence: null,
    });
    expect(clusters[0]?.scope.nodeIds).toEqual(["review"]);
  });

  it("weights repeated failed blocking gates above passed or advisory noise", () => {
    const clusters = rankSignals([
      ...clusterGateSignals([
        {
          id: "gate-1",
          projectId: "project-a",
          runId: "run-1",
          flowId: "flow-a",
          nodeId: "checks",
          gateId: "unit",
          kind: "command_check",
          mode: "blocking",
          status: "failed",
          verdict: { verdict: "fail", reasons: ["SECRET_KEY=abc failed"] },
        },
        {
          id: "gate-2",
          projectId: "project-a",
          runId: "run-2",
          flowId: "flow-a",
          nodeId: "checks",
          gateId: "unit",
          kind: "command_check",
          mode: "blocking",
          status: "failed",
          verdict: { verdict: "fail", recommendedAction: "rerun tests" },
        },
        {
          id: "gate-3",
          projectId: "project-a",
          runId: "run-3",
          flowId: "flow-a",
          nodeId: "checks",
          gateId: "style",
          kind: "command_check",
          mode: "advisory",
          status: "passed",
          verdict: { verdict: "pass" },
        },
      ]),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.key).toBe("gate:flow-a:checks:unit:failed");
    expect(clusters[0]?.priorityScore).toBeGreaterThan(100);
    expect(clusters[0]?.examples).toEqual([
      "secret_key=[redacted] failed",
      "rerun tests",
    ]);
  });

  it("clusters retries by flow, node, and error code", () => {
    const clusters = clusterRetrySignals([
      {
        id: "attempt-1",
        projectId: "project-a",
        runId: "run-1",
        flowId: "flow-a",
        nodeId: "checks",
        nodeType: "check",
        attempt: 1,
        errorCode: "TEST_FAIL",
        exitCode: 1,
      },
      {
        id: "attempt-2",
        projectId: "project-a",
        runId: "run-1",
        flowId: "flow-a",
        nodeId: "checks",
        nodeType: "check",
        attempt: 2,
        errorCode: "TEST_FAIL",
        exitCode: null,
      },
      {
        id: "attempt-3",
        projectId: "project-a",
        runId: "run-2",
        flowId: "flow-a",
        nodeId: "checks",
        nodeType: "check",
        attempt: 2,
        errorCode: "TEST_FAIL",
        exitCode: null,
      },
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      kind: "retry",
      occurrenceCount: 2,
      affectedRunCount: 2,
    });
    expect(clusters[0]?.drillDown).toEqual({
      flowId: "flow-a",
      nodeId: "checks",
    });
  });
});
