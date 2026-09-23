import type { DomainEventRow } from "@/lib/db/schema";

import { beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));
const currentCoordinator = vi.hoisted(() => vi.fn());
const wakeParkedCoordinator = vi.hoisted(() => vi.fn());

vi.mock("pino", () => ({ default: () => logger }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/flows/graph/coordinator-wake", () => ({
  currentCoordinator,
  wakeParkedCoordinator,
}));

import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";

function childEvent(kind: string): DomainEventRow {
  return {
    id: 7,
    kind,
    runId: "child-1",
    payload: { parentRunId: "parent-1" },
  } as unknown as DomainEventRow;
}

describe("orchestrator resume consumer — early settled child", () => {
  beforeEach(() => {
    logger.warn.mockClear();
    wakeParkedCoordinator.mockReset();
    currentCoordinator.mockReset();
  });

  it.each(["orchestrator", "consensus"])(
    "leaves a Running %s parent to its post-park catch-up and says so",
    async (nodeType) => {
      currentCoordinator.mockResolvedValue({
        status: "Running",
        failedChildWakeAt: null,
        nodeId: "coordinate",
        nodeAttemptId: "attempt-1",
        nodeType,
      });

      await buildOrchestratorResumeConsumer({ db: {} }).handle([
        childEvent("run.done"),
      ]);

      expect(wakeParkedCoordinator).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        {
          eventId: 7,
          childRunId: "child-1",
          parentRunId: "parent-1",
          nodeId: "coordinate",
          nodeAttemptId: "attempt-1",
        },
        "child settled before parent parked — catch-up owns the wake",
      );
    },
  );

  it("wakes a parked parent through the shared CAS, pinned to its attempt", async () => {
    currentCoordinator.mockResolvedValue({
      status: "WaitingOnChildren",
      failedChildWakeAt: null,
      nodeId: "coordinate",
      nodeAttemptId: "attempt-1",
      nodeType: "orchestrator",
    });
    wakeParkedCoordinator.mockResolvedValue({ kind: "pending", count: 1 });

    await buildOrchestratorResumeConsumer({ db: {} }).handle([
      childEvent("run.failed"),
    ]);

    expect(wakeParkedCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: "parent-1",
        cause: "settled_child",
        allowFailedOrchestratorChild: true,
        expectedAttemptId: "attempt-1",
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
