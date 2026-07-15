import type { RunPendingHitl } from "@/lib/queries/run";

// A pending `human` HITL whose stored schema declares `review: true` is a code
// review gate (allow-list + rework targets live on the row — see runner-graph
// `human_review` schema). Only these gates warrant an embedded diff; permission
// and intake-form gates do not.
export function isHumanReviewGate(
  pendingHitl: Pick<RunPendingHitl, "kind" | "schema"> | null,
): boolean {
  if (!pendingHitl || pendingHitl.kind !== "human") return false;

  const { schema } = pendingHitl;

  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { review?: unknown }).review === true
  );
}

// The persisted gate schema is the delivery contract. A missing or malformed
// current manifest must not replace the authenticated review workspace with a
// blind generic response form.
export function isFlowReviewGate(
  runKind: string,
  pendingHitl: Pick<RunPendingHitl, "kind" | "schema"> | null,
): boolean {
  return runKind === "flow" && isHumanReviewGate(pendingHitl);
}
