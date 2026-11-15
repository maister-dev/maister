import type { StoredDeliveryPolicy } from "@/lib/runs/delivery-policy";

import { snapshotResolvesTask } from "@/lib/runs/delivery-policy";

export type TaskCompletionRunEvidence = {
  id: string;
  status: string;
  promotionMode: string | null;
  promotionState: string | null;
  prState: string | null;
  deliveryPolicySnapshot: unknown | null;
};

export type TaskCompletionEvidence =
  | { ok: true; runId: string }
  | {
      ok: false;
      reason:
        | "run_missing"
        | "run_not_done"
        | "delivery_not_done"
        | "pull_request_not_merged";
      message: string;
      details: Record<string, unknown>;
    };

function deliveryStrategy(
  snapshot: unknown,
  fallback: string | null,
): string | null {
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const strategy = (snapshot as Partial<StoredDeliveryPolicy>).strategy;

    if (typeof strategy === "string") return strategy;
  }

  return fallback;
}

export function taskCompletionEvidence(
  latest: TaskCompletionRunEvidence | null | undefined,
): TaskCompletionEvidence {
  if (!latest) {
    return {
      ok: false,
      reason: "run_missing",
      message: "task completion requires a delivered flow run",
      details: {},
    };
  }

  if (latest.status !== "Done") {
    return {
      ok: false,
      reason: "run_not_done",
      message: `latest flow run is not Done (got ${latest.status})`,
      details: { runId: latest.id, runStatus: latest.status },
    };
  }

  if (latest.promotionState !== "done") {
    return {
      ok: false,
      reason: "delivery_not_done",
      message: "latest flow run has not been delivered",
      details: {
        runId: latest.id,
        promotionState: latest.promotionState ?? null,
      },
    };
  }

  const strategy = deliveryStrategy(
    latest.deliveryPolicySnapshot,
    latest.promotionMode,
  );

  if (strategy === "pull_request" && latest.prState !== "merged") {
    return {
      ok: false,
      reason: "pull_request_not_merged",
      message: "pull request delivery is not merged",
      details: { runId: latest.id, prState: latest.prState ?? null },
    };
  }

  return { ok: true, runId: latest.id };
}

// ADR-207: the single decision owner for automatic completion after a
// confirmed PR merge. "skip" = nothing to decide yet (no activity); "refuse" =
// merge confirmed but the task must not complete (one deduped activity).
export type MergeCompletionRefusal =
  "task_not_in_flight" | "superseded_by_newer_attempt" | "partial_resolution";

export type MergeCompletionState = {
  taskStatus: string;
  mergedRun: { id: string; runKind: string; prState: string | null } | null;
  newest: TaskCompletionRunEvidence | null;
};

export type MergeCompletionDecision =
  | { kind: "apply"; runId: string }
  | {
      kind: "skip";
      reason: "not_flow" | "not_merged" | "already_done" | "run_not_done";
    }
  | { kind: "refuse"; reason: MergeCompletionRefusal };

export function evaluateMergeCompletion(
  state: MergeCompletionState,
): MergeCompletionDecision {
  const { mergedRun, newest } = state;

  if (!mergedRun || mergedRun.runKind !== "flow") {
    return { kind: "skip", reason: "not_flow" };
  }
  if (mergedRun.prState !== "merged") {
    return { kind: "skip", reason: "not_merged" };
  }
  if (state.taskStatus === "Done") {
    return { kind: "skip", reason: "already_done" };
  }
  if (state.taskStatus !== "InFlight") {
    return { kind: "refuse", reason: "task_not_in_flight" };
  }
  if (newest?.id !== mergedRun.id) {
    return { kind: "refuse", reason: "superseded_by_newer_attempt" };
  }
  // Merged on the provider before finalize: the finalize's run.done re-evaluates.
  if (!taskCompletionEvidence(newest).ok) {
    return { kind: "skip", reason: "run_not_done" };
  }
  if (!snapshotResolvesTask(newest.deliveryPolicySnapshot)) {
    return { kind: "refuse", reason: "partial_resolution" };
  }

  return { kind: "apply", runId: newest.id };
}
