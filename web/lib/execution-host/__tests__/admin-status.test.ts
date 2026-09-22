import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  formatProjectionRearmCommand,
  parsePoisonCursorSearchParams,
  requireAdminExecutionHostStatus,
} from "@/lib/execution-host/admin-status";

const requireGlobalRoleMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: requireGlobalRoleMock,
}));

describe("execution host admin boundary", () => {
  beforeEach(() => {
    requireGlobalRoleMock.mockReset();
  });

  it("denies before any detailed database read", async () => {
    requireGlobalRoleMock.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "admin required"),
    );
    const execute = vi.fn(() => {
      throw new Error("detailed read must not run");
    });

    await expect(
      requireAdminExecutionHostStatus({ db: { execute } as never }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts only a complete, singular poison pagination cursor", () => {
    expect(parsePoisonCursorSearchParams({})).toBeUndefined();
    expect(
      parsePoisonCursorSearchParams({
        poisonRun: "run-1",
        poisonConsumer: "consumer-1",
      }),
    ).toEqual({ runId: "run-1", consumerName: "consumer-1" });

    for (const params of [
      { poisonRun: "run-1" },
      { poisonConsumer: "consumer-1" },
      { poisonRun: ["run-1"], poisonConsumer: "consumer-1" },
      { poisonRun: "", poisonConsumer: "consumer-1" },
      { poisonRun: "x".repeat(257), poisonConsumer: "consumer-1" },
    ]) {
      expect(() => parsePoisonCursorSearchParams(params)).toThrow(
        expect.objectContaining({ code: "PRECONDITION" }),
      );
    }
  });

  it("formats all five current-evidence arguments with shell-safe quoting", () => {
    expect(
      formatProjectionRearmCommand({
        consumerName: "run_projection_v1'; echo unsafe",
        runId: "run-1",
        poisonEventId: "event-1",
        lastRunSequence: null,
        errorEventId: "event-1",
        errorGeneration: "a3ad9da4-e801-4c98-8619-f6b4760f7cbe",
      }),
    ).toBe(
      "pnpm --filter maister-web execution:projection:rearm --consumer 'run_projection_v1'\"'\"'; echo unsafe' --run 'run-1' --event 'event-1' --cursor 'null' --error-generation 'a3ad9da4-e801-4c98-8619-f6b4760f7cbe'",
    );
  });

  it("withholds a command when poison evidence is incomplete or invalid", () => {
    expect(
      formatProjectionRearmCommand({
        consumerName: "run_projection_v1",
        runId: "run-1",
        poisonEventId: null,
        lastRunSequence: "1",
        errorEventId: null,
        errorGeneration: "invalid",
      }),
    ).toBeNull();

    expect(
      formatProjectionRearmCommand({
        consumerName: "run_projection_v1",
        runId: "run-1",
        poisonEventId: "event-current",
        lastRunSequence: "1",
        errorEventId: "event-stale",
        errorGeneration: "a3ad9da4-e801-4c98-8619-f6b4760f7cbe",
      }),
    ).toBeNull();
  });
});
