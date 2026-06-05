import type { ObservatoryFilters } from "@/lib/queries/observatory";

import { ARTIFACT_KINDS, type ArtifactKind } from "@/lib/config.schema";

export interface ObservatorySearchParams {
  artifactDefId?: string | string[];
  artifactKind?: string | string[];
  flowId?: string | string[];
  nodeId?: string | string[];
  windowDays?: string | string[];
}

export interface ParsedObservatoryFilters {
  filters: ObservatoryFilters;
  current: {
    artifactDefId?: string;
    artifactKind?: string;
    flowId?: string;
    nodeId?: string;
    windowDays: number;
  };
}

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const ARTIFACT_KIND_VALUES: ReadonlySet<string> = new Set(ARTIFACT_KINDS);

export function parseObservatorySearchParams(
  params: ObservatorySearchParams,
): ParsedObservatoryFilters {
  const artifactDefId = firstNonEmpty(params.artifactDefId);
  const artifactKind = firstNonEmpty(params.artifactKind);
  const validArtifactKind = parseArtifactKind(artifactKind);
  const flowId = firstNonEmpty(params.flowId);
  const nodeId = firstNonEmpty(params.nodeId);
  const windowDays = clampWindowDays(firstNonEmpty(params.windowDays));

  return {
    filters: {
      artifactDefId,
      artifactKind: validArtifactKind,
      flowId,
      nodeId,
      windowDays,
    },
    current: {
      artifactDefId,
      artifactKind,
      flowId,
      nodeId,
      windowDays,
    },
  };
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

function clampWindowDays(value: string | undefined): number {
  if (!value) return DEFAULT_WINDOW_DAYS;

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_DAYS;

  return Math.min(MAX_WINDOW_DAYS, Math.max(1, parsed));
}
