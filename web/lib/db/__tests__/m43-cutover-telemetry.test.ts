import { describe, expect, it } from "vitest";

import {
  emptyM43CutoverTelemetry,
  readM43CutoverTelemetry,
} from "@/lib/db/m43-cutover-telemetry";

describe("M43 cut-over migration telemetry", () => {
  it("summarizes the exact candidate-store closure counts", async () => {
    const telemetry = await readM43CutoverTelemetry({
      execute: async () => ({
        rows: [
          {
            runId: "run-b",
            priorStatus: "Running",
            nodeAttemptsClosed: 2,
            hitlRequestsCancelled: 1,
            assignmentsClosed: 0,
            sessionsCleared: 1,
          },
          {
            runId: "run-a",
            priorStatus: "NeedsInput",
            nodeAttemptsClosed: "1",
            hitlRequestsCancelled: "0",
            assignmentsClosed: "1",
            sessionsCleared: "0",
          },
        ],
      }),
    });

    expect(telemetry).toEqual({
      candidateCount: 2,
      transitionedCount: 2,
      nodeAttemptsClosed: 3,
      hitlRequestsCancelled: 1,
      assignmentsClosed: 1,
      sessionsCleared: 1,
      candidates: [
        {
          runId: "run-b",
          priorStatus: "Running",
          nodeAttemptsClosed: 2,
          hitlRequestsCancelled: 1,
          assignmentsClosed: 0,
          sessionsCleared: 1,
        },
        {
          runId: "run-a",
          priorStatus: "NeedsInput",
          nodeAttemptsClosed: 1,
          hitlRequestsCancelled: 0,
          assignmentsClosed: 1,
          sessionsCleared: 0,
        },
      ],
    });
  });

  it("has a zero-valued summary when M43 has no candidates", () => {
    expect(emptyM43CutoverTelemetry()).toEqual({
      candidateCount: 0,
      transitionedCount: 0,
      nodeAttemptsClosed: 0,
      hitlRequestsCancelled: 0,
      assignmentsClosed: 0,
      sessionsCleared: 0,
      candidates: [],
    });
  });
});
