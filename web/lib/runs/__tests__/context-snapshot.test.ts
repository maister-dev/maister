import type { ContextSnapshot } from "../context-snapshot";

import { expect, it } from "vitest";

import { latestContextSnapshot } from "../context-snapshot";

const completed: ContextSnapshot = {
  type: "session.context_snapshot",
  runId: "run-1",
  runSessionId: "session-1",
  incarnationId: "incarnation-1",
  bindingObservedAt: "2026-11-20T10:00:00.000001Z",
  nodeAttemptId: null,
  lifecycleSequence: "12",
  contextSequence: "16",
  transcriptSequence: "15",
  usage: {
    used: 80,
    size: 100,
    sizeSource: "agent_reported",
    observedAt: "2026-11-20T10:01:00.000Z",
    sourceSequence: "16",
  },
  activeCompactions: 0,
  completedCompactions: 1,
  coverage: "from_incarnation_start",
  windowAdvisory: null,
};

const rebound = {
  ...completed,
  incarnationId: "incarnation-2",
  bindingObservedAt: "2026-11-20T10:02:00.000002Z",
  lifecycleSequence: null,
  contextSequence: null,
  usage: null,
  completedCompactions: 0,
  coverage: "partial",
} satisfies typeof completed;

it.each([
  { source: "live", hydration: completed, live: rebound },
  { source: "hydration", hydration: rebound, live: completed },
])(
  "uses the newer $source binding while its canonical create event is pending",
  ({ hydration, live }) => {
    expect(latestContextSnapshot(hydration, live)).toBe(rebound);
  },
);

it("uses the observed active session when it predates the session it replaces", () => {
  const previous: ContextSnapshot = { ...rebound, lifecycleSequence: "20" };
  const current: ContextSnapshot = {
    ...completed,
    bindingObservedAt: "2026-11-20T10:03:00.000003Z",
  };

  expect(latestContextSnapshot(previous, current)).toBe(current);
});
