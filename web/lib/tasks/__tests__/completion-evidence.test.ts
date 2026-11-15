import { describe, expect, it } from "vitest";

import {
  evaluateMergeCompletion,
  taskCompletionEvidence,
  type MergeCompletionDecision,
  type MergeCompletionState,
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

describe("evaluateMergeCompletion (ADR-207)", () => {
  const prDone = run({
    promotionMode: "pull_request",
    prState: "merged",
    deliveryPolicySnapshot: {
      strategy: "pull_request",
      push: "on_success",
      trigger: "manual",
      targetBranch: "main",
    },
  });

  function state(
    over: Partial<MergeCompletionState> = {},
  ): MergeCompletionState {
    return {
      taskStatus: "InFlight",
      mergedRun: { id: "run-1", runKind: "flow", prState: "merged" },
      newest: prDone,
      ...over,
    };
  }

  it.each<[string, Partial<MergeCompletionState>, MergeCompletionDecision]>([
    [
      "eligible newest merged attempt (legacy snapshot: no resolvesTask ⇒ resolves)",
      {},
      { kind: "apply", runId: "run-1" },
    ],
    ["missing run", { mergedRun: null }, { kind: "skip", reason: "not_flow" }],
    [
      "agent run",
      { mergedRun: { id: "run-1", runKind: "agent", prState: "merged" } },
      { kind: "skip", reason: "not_flow" },
    ],
    [
      "PR not merged (run.done of a PR open)",
      { mergedRun: { id: "run-1", runKind: "flow", prState: "open" } },
      { kind: "skip", reason: "not_merged" },
    ],
    [
      "PR closed unmerged",
      { mergedRun: { id: "run-1", runKind: "flow", prState: "closed" } },
      { kind: "skip", reason: "not_merged" },
    ],
    [
      "task already Done",
      { taskStatus: "Done" },
      { kind: "skip", reason: "already_done" },
    ],
    [
      "merged before finalize (Run parked)",
      { newest: run({ ...prDone, status: "Review", promotionState: "none" }) },
      { kind: "skip", reason: "run_not_done" },
    ],
    [
      "task Backlog",
      { taskStatus: "Backlog" },
      { kind: "refuse", reason: "task_not_in_flight" },
    ],
    [
      "task Abandoned",
      { taskStatus: "Abandoned" },
      { kind: "refuse", reason: "task_not_in_flight" },
    ],
    [
      "newer attempt exists",
      { newest: run({ ...prDone, id: "run-2" }) },
      { kind: "refuse", reason: "superseded_by_newer_attempt" },
    ],
    [
      "partial resolution",
      {
        newest: run({
          ...prDone,
          deliveryPolicySnapshot: {
            ...(prDone.deliveryPolicySnapshot as object),
            resolvesTask: false,
          },
        }),
      },
      { kind: "refuse", reason: "partial_resolution" },
    ],
  ])("%s", (_name, over, expected) => {
    expect(evaluateMergeCompletion(state(over))).toEqual(expected);
  });
});
