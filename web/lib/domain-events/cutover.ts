import type { DomainEventRow } from "@/lib/db/schema";

export const GRAPH_ONLY_CUTOVER_REASON =
  "legacy_steps_engine_3_cutover" as const;
export const GRAPH_ONLY_CUTOVER_SOURCE = "upgrade_cutover" as const;

export function isGraphOnlyCutoverFailure(
  event: Pick<DomainEventRow, "kind" | "payload">,
): boolean {
  if (event.kind !== "run.failed") return false;

  const payload = event.payload as Record<string, unknown>;

  return (
    payload.reason === GRAPH_ONLY_CUTOVER_REASON &&
    payload.source === GRAPH_ONLY_CUTOVER_SOURCE
  );
}
