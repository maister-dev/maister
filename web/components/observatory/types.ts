import type {
  CostDimensionRow,
  ObservatoryArtifactSummary,
  ObservatoryBudgetSummary,
  ObservatoryNodeDetail,
  ObservatoryNodeSummary,
  ObservatoryPortfolio,
  ObservatoryProject,
} from "@/lib/queries/observatory";
import type {
  CoverageFlow,
  GateFiringRollup,
  NeverFiredFlag,
  ObservatoryHarness,
} from "@/lib/queries/observatory-core";
import type { SignalKind } from "@/lib/queries/observatory-signals";

export interface ObservatoryHarnessLabels {
  sectionTitle: string;
  sectionSubtitle: string;
  firingTitle: string;
  noFiring: string;
  gate: string;
  kind: string;
  mode: string;
  executions: string;
  passed: string;
  failed: string;
  stale: string;
  failRate: string;
  neverFired: string;
  neverFiredHint: string;
  insufficientData: string;
  byKind: string;
  coverageTitle: string;
  noCoverage: string;
  revisions: string;
  blocking: string;
  advisory: string;
  guides: string;
  guidesWithoutSensors: string;
  effectivenessTitle: string;
  noEffectiveness: string;
  capabilitiesTitle: string;
  reworkAfterFail: string;
  reworkAfterPass: string;
  lift: string;
  capability: string;
  withCapability: string;
  withoutCapability: string;
  noCapabilities: string;
}

export interface ObservatoryBudgetLabels {
  title: string;
  subtitle: string;
  escalations: string;
  terminations: string;
  guardrailTrips: string;
  warnNotSurfaced: string;
}

export interface ObservatoryCostBreakdownLabels {
  byModelTitle: string;
  byRunnerTitle: string;
  modelHeader: string;
  runnerHeader: string;
  inputHeader: string;
  outputHeader: string;
  cacheHeader: string;
  totalHeader: string;
  empty: string;
}

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
  artifactDefId: string;
  artifactKind: string;
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
  harness: ObservatoryHarnessLabels;
  budget: ObservatoryBudgetLabels;
  costBreakdown: ObservatoryCostBreakdownLabels;
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
    artifactDefId?: string;
    artifactKind?: string;
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

export interface SensorFiringCardProps {
  firing: GateFiringRollup;
  neverFired: readonly NeverFiredFlag[];
  labels: ObservatoryLabels;
  projectSlug?: string;
}

export interface CoverageMapCardProps {
  coverage: readonly CoverageFlow[];
  labels: ObservatoryLabels;
}

export interface ControlEffectivenessCardProps {
  effectiveness: ObservatoryHarness["effectiveness"];
  labels: ObservatoryLabels;
}

export interface BudgetSurfaceCardProps {
  budget: ObservatoryBudgetSummary;
  labels: ObservatoryLabels;
  locale: string;
}

export interface CostBreakdownCardProps {
  rows: readonly CostDimensionRow[];
  title: string;
  keyHeader: string;
  labels: ObservatoryLabels;
  locale: string;
  testId?: string;
}
