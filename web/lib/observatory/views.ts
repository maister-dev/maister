// ADR-177 D6: the Observatory's four URL views.
//
// Pure and client-safe — the filter bar and the view tabs both build hrefs from
// these, and the two page routes narrow `?view=` through the same allow-list.

export const OBSERVATORY_VIEWS = [
  "overview",
  "cost",
  "quality",
  "harness",
] as const;

export type ObservatoryView = (typeof OBSERVATORY_VIEWS)[number];

const OBSERVATORY_VIEW_SET: ReadonlySet<string> = new Set(OBSERVATORY_VIEWS);

export function isObservatoryView(value: string): value is ObservatoryView {
  return OBSERVATORY_VIEW_SET.has(value);
}

/**
 * The view a link lands on when it names none.
 *
 * A link carrying a flow-ledger drill-down key was written before the view axis
 * existed and means the Quality view — landing it on the overview would show a
 * table its filters do not touch.
 */
export function defaultObservatoryView(params: {
  artifactDefId?: string;
  artifactKind?: string;
  flowId?: string;
  nodeId?: string;
}): ObservatoryView {
  return (params.flowId ??
    params.nodeId ??
    params.artifactKind ??
    params.artifactDefId)
    ? "quality"
    : "overview";
}
