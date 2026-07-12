export const OBSERVATORY_RUN_KINDS = [
  "all",
  "flow",
  "scratch",
  "agent",
] as const;

export const DELIVERY_RUN_KINDS = ["flow", "scratch", "agent"] as const;

export type ObservatoryRunKind = (typeof OBSERVATORY_RUN_KINDS)[number];
export type DeliveryRunKind = (typeof DELIVERY_RUN_KINDS)[number];

const OBSERVATORY_RUN_KIND_SET: ReadonlySet<string> = new Set(
  OBSERVATORY_RUN_KINDS,
);

export function isObservatoryRunKind(
  value: string,
): value is ObservatoryRunKind {
  return OBSERVATORY_RUN_KIND_SET.has(value);
}

export function isFlowLedgerApplicable(runKind: ObservatoryRunKind): boolean {
  return runKind === "all" || runKind === "flow";
}

export function isDeliveryRunKind(value: string): value is DeliveryRunKind {
  return value === "flow" || value === "scratch" || value === "agent";
}
