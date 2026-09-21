import type { ObservatoryFilters } from "@/lib/queries/observatory";
import type { ObservatoryPeriod } from "@/lib/observatory/period";
import type { ObservatoryRunKind } from "@/lib/observatory/run-kind";
import type { ObservatoryView } from "@/lib/observatory/views";

import { ARTIFACT_KINDS, type ArtifactKind } from "@/lib/config.schema";
import { resolveObservatoryPeriod } from "@/lib/observatory/period";
import { isObservatoryRunKind } from "@/lib/observatory/run-kind";
import {
  defaultObservatoryView,
  isObservatoryView,
  observatoryViewOwns,
} from "@/lib/observatory/views";

export interface ObservatorySearchParams {
  artifactDefId?: string | string[];
  artifactKind?: string | string[];
  flowId?: string | string[];
  from?: string | string[];
  nodeId?: string | string[];
  project?: string | string[];
  runKind?: string | string[];
  to?: string | string[];
  view?: string | string[];
  windowDays?: string | string[];
}

export interface ParsedObservatoryFilters {
  filters: ObservatoryFilters;
  current: {
    artifactDefId?: string;
    artifactKind?: string;
    flowId?: string;
    nodeId?: string;
    /** Raw candidate slug — the page resolves it against the visible set. */
    project?: string;
    runKind: ObservatoryRunKind;
    view: ObservatoryView;
    /** Effective period, for the bar to render (never the requested values). */
    period: ObservatoryPeriod;
  };
}

const ARTIFACT_KIND_VALUES: ReadonlySet<string> = new Set(ARTIFACT_KINDS);

export function parseObservatorySearchParams(
  params: ObservatorySearchParams,
  now: Date = new Date(),
): ParsedObservatoryFilters {
  const requestedArtifactDefId = firstNonEmpty(params.artifactDefId);
  const requestedArtifactKind = firstNonEmpty(params.artifactKind);
  const requestedFlowId = firstNonEmpty(params.flowId);
  const requestedNodeId = firstNonEmpty(params.nodeId);
  const project = firstNonEmpty(params.project);
  const runKind = parseRunKind(params.runKind);
  // ONE `now` feeds the period and every query's volatility check, so a page
  // read cannot straddle two clocks.
  const period = resolveObservatoryPeriod({
    now,
    windowDays: firstNonEmpty(params.windowDays),
    from: firstNonEmpty(params.from),
    to: firstNonEmpty(params.to),
  });
  // The default is read from the RAW keys: a pre-view drill-down link carries
  // them with no `view=`, and it means Quality (D6).
  const view =
    parseView(params.view) ??
    defaultObservatoryView({
      artifactDefId: requestedArtifactDefId,
      artifactKind: requestedArtifactKind,
      flowId: requestedFlowId,
      nodeId: requestedNodeId,
    });
  // D7 owns the fields per view, and a param the view does not own is dropped
  // HERE — the one place both the applied `filters` and the rendered `current`
  // are derived. Dropping it only in the tab href would still leave a pasted
  // `?view=harness&artifactDefId=…` narrowing the harness metrics through a
  // control that view never renders.
  const owned = <T>(
    key: Parameters<typeof observatoryViewOwns>[1],
    value: T,
  ) => (observatoryViewOwns(view, key) ? value : undefined);
  const artifactDefId = owned("artifactDefId", requestedArtifactDefId);
  const artifactKind = owned("artifactKind", requestedArtifactKind);
  const validArtifactKind = parseArtifactKind(artifactKind);
  const flowId = owned("flowId", requestedFlowId);
  const nodeId = owned("nodeId", requestedNodeId);

  return {
    filters: {
      artifactDefId,
      artifactKind: validArtifactKind,
      flowId,
      nodeId,
      now,
      projectSlug: project,
      runKind,
      since: period.since,
      until: period.until,
    },
    current: {
      artifactDefId,
      artifactKind,
      flowId,
      nodeId,
      period,
      project,
      runKind,
      view,
    },
  };
}

// A repeated param takes its FIRST value, exactly like every other field here
// (`firstNonEmpty`). Treating `?view=a&view=b` as "reset to the default" made
// two fields disagree with the rest of the bar, and made a repeated `view`
// skip the drill-down default below.
function parseRunKind(
  value: ObservatorySearchParams["runKind"],
): ObservatoryRunKind {
  const normalized = firstNonEmpty(value);

  return normalized && isObservatoryRunKind(normalized) ? normalized : "all";
}

function parseView(
  value: ObservatorySearchParams["view"],
): ObservatoryView | undefined {
  const normalized = firstNonEmpty(value);

  if (!normalized) return undefined;

  return isObservatoryView(normalized) ? normalized : "overview";
}

function firstNonEmpty(
  value: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();

  return trimmed ? trimmed : undefined;
}

function parseArtifactKind(
  value: string | undefined,
): ObservatoryFilters["artifactKind"] {
  if (!value) return undefined;

  return isArtifactKind(value) ? value : undefined;
}

function isArtifactKind(value: string): value is ArtifactKind {
  return ARTIFACT_KIND_VALUES.has(value);
}
