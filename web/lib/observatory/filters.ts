import type { ObservatoryFilters } from "@/lib/queries/observatory";

export interface ObservatorySearchParams {
  flowId?: string | string[];
  nodeId?: string | string[];
  windowDays?: string | string[];
}

export interface ParsedObservatoryFilters {
  filters: ObservatoryFilters;
  current: {
    flowId?: string;
    nodeId?: string;
    windowDays: number;
  };
}

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

export function parseObservatorySearchParams(
  params: ObservatorySearchParams,
): ParsedObservatoryFilters {
  const flowId = firstNonEmpty(params.flowId);
  const nodeId = firstNonEmpty(params.nodeId);
  const windowDays = clampWindowDays(firstNonEmpty(params.windowDays));

  return {
    filters: {
      flowId,
      nodeId,
      windowDays,
    },
    current: {
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

function clampWindowDays(value: string | undefined): number {
  if (!value) return DEFAULT_WINDOW_DAYS;

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_DAYS;

  return Math.min(MAX_WINDOW_DAYS, Math.max(1, parsed));
}
