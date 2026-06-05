import type {
  ObservatoryArtifactSummary,
  ObservatoryNodeDetail,
  ObservatoryNodeSummary,
  ObservatoryPortfolio,
  ObservatoryProject,
} from "@/lib/queries/observatory";
import type { SignalKind } from "@/lib/queries/observatory-signals";

export interface ObservatoryLabels {
  title: string;
  subtitle: string;
  projectTitle: string;
  correctionRate: string;
  correctionFormula: string;
  rework: string;
  retries: string;
  runs: string;
  autonomyScore: string;
  waitTime: string;
  openWaits: string;
  volatile: string;
  reviewDwellExcluded: string;
  nodes: string;
  noNodes: string;
  artifacts: string;
  noArtifacts: string;
  signals: string;
  noSignals: string;
  observationsOnly: string;
  filters: string;
  flow: string;
  node: string;
  lookback: string;
  apply: string;
  all: string;
  days: string;
  drillDown: string;
  latestAttempt: string;
  historicalAttempts: string;
  gates: string;
  hitlWaits: string;
  kind: Record<SignalKind, string>;
}

export type ObservatorySummaryData = ObservatoryPortfolio | ObservatoryProject;

export interface ObservatoryDashboardProps {
  data: ObservatorySummaryData;
  labels: ObservatoryLabels;
  projectSlug?: string;
}

export interface ObservatoryNodeDrilldownProps {
  detail: ObservatoryNodeDetail;
  labels: ObservatoryLabels;
}

export interface ObservatoryFilterProps {
  labels: ObservatoryLabels;
  current: {
    flowId?: string;
    nodeId?: string;
    windowDays: number;
  };
}

export interface CorrectionHeatmapProps {
  labels: ObservatoryLabels;
  nodes: readonly ObservatoryNodeSummary[];
  projectSlug?: string;
}

export interface ArtifactListProps {
  artifacts: readonly ObservatoryArtifactSummary[];
  labels: ObservatoryLabels;
}
