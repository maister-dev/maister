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
  const artifactDefId = firstNonEmpty(params.artifactDefId);
  const artifactKind = firstNonEmpty(params.artifactKind);
  const validArtifactKind = parseArtifactKind(artifactKind);
  const flowId = firstNonEmpty(params.flowId);
  const nodeId = firstNonEmpty(params.nodeId);
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
  const view =
    parseView(params.view) ??
    defaultObservatoryView({ artifactDefId, artifactKind, flowId, nodeId });

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

function parseRunKind(
  value: ObservatorySearchParams["runKind"],
): ObservatoryRunKind {
  if (Array.isArray(value)) return "all";

  const normalized = value?.trim();

  return normalized && isObservatoryRunKind(normalized) ? normalized : "all";
}

function parseView(
  value: ObservatorySearchParams["view"],
): ObservatoryView | undefined {
  if (Array.isArray(value)) return "overview";

  const normalized = value?.trim();

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
