import { describe, expect, it } from "vitest";

import {
  taskCompletionEvidence,
  type TaskCompletionRunEvidence,
} from "@/lib/tasks/completion-evidence";

function run(
  over: Partial<TaskCompletionRunEvidence> = {},
): TaskCompletionRunEvidence {
  return {
    id: "run-1",
    status: "Done",
    promotionMode: "local_merge",
    promotionState: "done",
    prState: null,
    deliveryPolicySnapshot: {
      strategy: "merge",
      push: "never",
      trigger: "manual",
      targetBranch: "main",
    },
    ...over,
  };
}

describe("taskCompletionEvidence", () => {
  it("accepts a promoted local merge", () => {
    expect(taskCompletionEvidence(run())).toEqual({
      ok: true,
      runId: "run-1",
    });
  });

  it("rejects missing, unfinished, and result-only runs", () => {
    expect(taskCompletionEvidence(null)).toMatchObject({
      ok: false,
      reason: "run_missing",
    });
    expect(taskCompletionEvidence(run({ status: "Review" }))).toMatchObject({
      ok: false,
      reason: "run_not_done",
    });
    expect(
      taskCompletionEvidence(run({ promotionState: "none" })),
    ).toMatchObject({ ok: false, reason: "delivery_not_done" });
  });

  it("accepts pull-request delivery only after provider-observed merge", () => {
    const pullRequest = {
      promotionMode: "pull_request",
      deliveryPolicySnapshot: {
        strategy: "pull_request",
        push: "never",
        trigger: "manual",
        targetBranch: "main",
      },
    } as const;

    expect(
      taskCompletionEvidence(run({ ...pullRequest, prState: "open" })),
    ).toMatchObject({ ok: false, reason: "pull_request_not_merged" });
    expect(
      taskCompletionEvidence(run({ ...pullRequest, prState: "merged" })),
    ).toEqual({ ok: true, runId: "run-1" });
  });

  it("uses the immutable delivery snapshot over the workspace fallback", () => {
    expect(
      taskCompletionEvidence(
        run({
          promotionMode: "local_merge",
          prState: "open",
          deliveryPolicySnapshot: {
            strategy: "pull_request",
            push: "never",
            trigger: "manual",
            targetBranch: "main",
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "pull_request_not_merged" });
  });
});
