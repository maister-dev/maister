import type { StoredDeliveryPolicy } from "@/lib/runs/delivery-policy";

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
