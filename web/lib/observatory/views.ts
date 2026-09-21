// ADR-178 D6: the Observatory's four URL views.
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

/** The flow-ledger drill-down keys, in the order every serializer writes them. */
export const OBSERVATORY_DRILLDOWN_KEYS = [
  "flowId",
  "nodeId",
  "artifactKind",
  "artifactDefId",
] as const;

export type ObservatoryDrilldownKey =
  (typeof OBSERVATORY_DRILLDOWN_KEYS)[number];

/**
 * D7's field-per-view table, as code: flow and node on Quality and Harness,
 * artifact kind and definition on Quality alone.
 *
 * A param a view does not own is not a filter. `parseObservatorySearchParams`
 * drops it, so a stale tab href, a bookmark or a hand-written URL cannot narrow
 * a read model through a control the bar does not render — an invisible filter
 * is a wrong number with no way to see why.
 */
export function observatoryViewOwns(
  view: ObservatoryView,
  key: ObservatoryDrilldownKey,
): boolean {
  if (key === "artifactKind" || key === "artifactDefId") {
    return view === "quality";
  }

  return view === "quality" || view === "harness";
}
