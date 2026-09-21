import type { ObservatoryPeriod } from "@/lib/observatory/period";
import type { ObservatoryRunKind } from "@/lib/observatory/run-kind";
import type { ObservatoryView } from "@/lib/observatory/views";
import type { ParsedObservatoryFilters } from "@/lib/observatory/filters";

import { DEFAULT_OBSERVATORY_WINDOW_DAYS } from "@/lib/observatory/period";
import {
  OBSERVATORY_DRILLDOWN_KEYS,
  observatoryViewOwns,
} from "@/lib/observatory/views";

// ADR-177 D6/D7/D8: every Observatory link is built here.
//
// The URL is the state, so a link that drops the period silently changes what
// the reader is looking at. One serializer, one param order — deterministic
// enough for tests, and impossible for a call site to half-implement.
//
// Pure and client-safe: the filter bar is a Client Component.

export type ObservatoryCurrent = ParsedObservatoryFilters["current"];

export type ObservatoryHrefPatch = Partial<{
  view: ObservatoryView;
  /** A preset span; drops any custom range. */
  windowDays: number;
  /** A custom range; drops the preset. Both must be present to take effect. */
  from: string | null;
  to: string | null;
  runKind: ObservatoryRunKind;
  project: string | null;
  flowId: string | null;
  nodeId: string | null;
  artifactKind: string | null;
  artifactDefId: string | null;
}>;

type DrilldownKey = (typeof OBSERVATORY_DRILLDOWN_KEYS)[number];

interface HrefState {
  view: ObservatoryView;
  windowDays?: number;
  from?: string;
  to?: string;
  runKind: ObservatoryRunKind;
  project?: string;
  flowId?: string;
  nodeId?: string;
  artifactKind?: string;
  artifactDefId?: string;
}

function stateOf(current: ObservatoryCurrent): HrefState {
  const custom =
    current.period.from !== undefined && current.period.to !== undefined;

  return {
    view: current.view,
    windowDays: custom ? undefined : current.period.windowDays,
    from: custom ? current.period.from : undefined,
    to: custom ? current.period.to : undefined,
    runKind: current.runKind,
    project: current.project,
    flowId: current.flowId,
    nodeId: current.nodeId,
    artifactKind: current.artifactKind,
    artifactDefId: current.artifactDefId,
  };
}

function serialize(state: HrefState): string {
  const params = new URLSearchParams();

  params.set("view", state.view);
  if (state.from !== undefined && state.to !== undefined) {
    params.set("from", state.from);
    params.set("to", state.to);
  } else {
    // Every link states its period explicitly (AC3). Clearing one end of a
    // custom range leaves no window at all, and an implicit default is a
    // link that stops meaning what it meant.
    params.set(
      "windowDays",
      String(state.windowDays ?? DEFAULT_OBSERVATORY_WINDOW_DAYS),
    );
  }
  // `all` is the parse default; emitting it would make "cleared" and "all"
  // two different URLs for one view.
  if (state.runKind !== "all") params.set("runKind", state.runKind);
  if (state.project) params.set("project", state.project);
  for (const key of OBSERVATORY_DRILLDOWN_KEYS) {
    const value = state[key];

    if (value) params.set(key, value);
  }

  return params.toString();
}

function withPatch(state: HrefState, patch: ObservatoryHrefPatch): HrefState {
  const next: HrefState = { ...state };

  if (patch.view !== undefined) next.view = patch.view;
  if (patch.runKind !== undefined) next.runKind = patch.runKind;
  if (patch.windowDays !== undefined) {
    next.windowDays = patch.windowDays;
    next.from = undefined;
    next.to = undefined;
  }
  if (patch.from !== undefined || patch.to !== undefined) {
    const from =
      patch.from !== undefined ? (patch.from ?? undefined) : next.from;
    const to = patch.to !== undefined ? (patch.to ?? undefined) : next.to;

    next.from = from;
    next.to = to;
    // A half-filled custom range still needs a window to read by, so the
    // preset stays until both ends are present.
    next.windowDays =
      from !== undefined && to !== undefined
        ? undefined
        : (next.windowDays ?? state.windowDays);
  }
  if (patch.project !== undefined) next.project = patch.project ?? undefined;
  for (const key of OBSERVATORY_DRILLDOWN_KEYS) {
    const value = patch[key];

    if (value !== undefined) next[key] = value ?? undefined;
  }

  return next;
}

export function buildObservatoryHref(
  pathname: string,
  current: ObservatoryCurrent,
  patch: ObservatoryHrefPatch = {},
): string {
  return `${pathname}?${serialize(withPatch(stateOf(current), patch))}`;
}

/**
 * A view tab's href. Every drill-down key the TARGET view does not own is
 * dropped (D7): they mean nothing there, and carrying them would make the tab
 * land on a page filtered by a control it does not render. Quality alone owns
 * the artifact pair, so Quality → Harness drops it while keeping flow and node.
 *
 * `parseObservatorySearchParams` drops the same keys again on arrival — that is
 * the guard for URLs this function never built; this keeps the URL itself
 * honest about what the page is filtered by.
 */
export function observatoryViewHref(
  pathname: string,
  current: ObservatoryCurrent,
  view: ObservatoryView,
): string {
  const drop = Object.fromEntries(
    OBSERVATORY_DRILLDOWN_KEYS.filter(
      (key) => !observatoryViewOwns(view, key),
    ).map((key) => [key, null]),
  ) as ObservatoryHrefPatch;

  return buildObservatoryHref(pathname, current, { ...drop, view });
}

/**
 * A flow-ledger drill-down link (heatmap cell, signal, sensor row).
 *
 * Always lands on Quality and always carries the period, so the page the link
 * opens describes the same window the reader was looking at.
 */
export function observatoryDrilldownHref(
  pathname: string,
  input: {
    period: ObservatoryPeriod;
    runKind?: ObservatoryRunKind;
    view?: ObservatoryView;
  } & Partial<Record<DrilldownKey, string | null>>,
): string {
  const custom =
    input.period.from !== undefined && input.period.to !== undefined;

  return `${pathname}?${serialize({
    view: input.view ?? "quality",
    windowDays: custom ? undefined : input.period.windowDays,
    from: custom ? input.period.from : undefined,
    to: custom ? input.period.to : undefined,
    runKind: input.runKind ?? "all",
    flowId: input.flowId ?? undefined,
    nodeId: input.nodeId ?? undefined,
    artifactKind: input.artifactKind ?? undefined,
    artifactDefId: input.artifactDefId ?? undefined,
  })}`;
}
