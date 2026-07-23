import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors-core";
import {
  assertScheduledLaunchTransition,
  hashScheduledLaunchCreateRequest,
  hashScheduledLaunchRequest,
  normalizeScheduledLaunchRequest,
} from "@/lib/scheduled-launches/service";

describe("scheduled launch state transitions", () => {
  it("allows only the frozen mutable and claim transitions", () => {
    expect(() =>
      assertScheduledLaunchTransition("Scheduled", "Dispatching"),
    ).not.toThrow();
    expect(() =>
      assertScheduledLaunchTransition("RetryWaiting", "Scheduled"),
    ).not.toThrow();
  });

  it("refuses cancellation or re-arming after dispatch has won", () => {
    expect(() =>
      assertScheduledLaunchTransition("Dispatching", "Cancelled"),
    ).toThrow(
      expect.objectContaining<Partial<MaisterError>>({ code: "PRECONDITION" }),
    );
    expect(() =>
      assertScheduledLaunchTransition("Launched", "Scheduled"),
    ).toThrow(
      expect.objectContaining<Partial<MaisterError>>({ code: "PRECONDITION" }),
    );
  });
});

describe("normalizeScheduledLaunchRequest", () => {
  it("keeps only the public launch subset and hashes equal requests canonically", () => {
    const first = normalizeScheduledLaunchRequest({
      flowId: "maintenance",
      targetBranch: "main",
      autoPromote: false,
      packageVersions: { packageB: "keep", packageA: "adopt" },
    });
    const reordered = normalizeScheduledLaunchRequest({
      packageVersions: { packageA: "adopt", packageB: "keep" },
      autoPromote: false,
      targetBranch: "main",
      flowId: "maintenance",
    });

    expect(first).toEqual({
      flowId: "maintenance",
      targetBranch: "main",
      autoPromote: false,
      packageVersions: { packageA: "adopt", packageB: "keep" },
    });
    expect(hashScheduledLaunchRequest(first)).toEqual(
      hashScheduledLaunchRequest(reordered),
    );
  });

  it("binds idempotency to the task and requested time as well as launch options", () => {
    const request = normalizeScheduledLaunchRequest({ flowId: "maintenance" });
    const first = hashScheduledLaunchCreateRequest({
      taskId: "task-a",
      scheduledLocalTime: "2026-11-01T10:00",
      timezone: "UTC",
      launchRequest: request,
    });
    const changedTask = hashScheduledLaunchCreateRequest({
      taskId: "task-b",
      scheduledLocalTime: "2026-11-01T10:00",
      timezone: "UTC",
      launchRequest: request,
    });
    const changedTime = hashScheduledLaunchCreateRequest({
      taskId: "task-a",
      scheduledLocalTime: "2026-11-01T10:01",
      timezone: "UTC",
      launchRequest: request,
    });

    expect(changedTask).not.toBe(first);
    expect(changedTime).not.toBe(first);
  });

  it.each([
    { allowConcurrent: true },
    { agentId: "agent-1" },
    { triggerSource: "cron" },
    { queueAdmitted: true },
  ])("rejects an internal or force-launch field: %o", (forbiddenField) => {
    expect(() =>
      normalizeScheduledLaunchRequest({
        flowId: "maintenance",
        ...forbiddenField,
      }),
    ).toThrow(
      expect.objectContaining<Partial<MaisterError>>({ code: "CONFIG" }),
    );
  });
});
