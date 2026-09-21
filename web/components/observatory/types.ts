import type {
  CostDimensionRow,
  CostKindRow,
  BudgetKindRow,
  ObservatoryArtifactSummary,
  ObservatoryBudgetSummary,
  ObservatoryNodeDetail,
  ObservatoryNodeSummary,
  ObservatoryPortfolio,
  ObservatoryProject,
} from "@/lib/queries/observatory";
import type {
  AgentizationSummary,
  ObservatoryFunnel,
} from "@/lib/queries/observatory-agentization-core";
import type {
  DeliveryRunKind,
  ObservatoryRunKind,
} from "@/lib/observatory/run-kind";
import type { ObservatoryPeriod } from "@/lib/observatory/period";
import type { ParsedObservatoryFilters } from "@/lib/observatory/filters";
import type { OverviewTable } from "@/lib/queries/observatory-overview";
import type { RunOutcomeBucket } from "@/lib/runs/outcome-bucket";
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
  byKind: string;
  unattributedLegacy: string;
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
  byKindTitle: string;
  byFlowTitle: string;
  flowHeader: string;
}

export interface ObservatoryAgentizationLabels {
  title: string;
  subtitle: string;
  lines: string;
  deliveryUnits: string;
  additions: string;
  deletions: string;
  asOf: string;
  insufficient: string;
  volatility: string;
  trend: string;
  trendNoData: string;
  trendValue: string;
  trendAiLines: string;
  trendAllLines: string;
}

export interface ObservatoryFunnelLabels {
  title: string;
  subtitle: string;
  runKind: string;
  launchMode: string;
  triggerSource: string;
  humanTouch: string;
  throughput: string;
  promotionLane: string;
  pureAutonomous: string;
  aiWithCorrection: string;
  humanTakeover: string;
  platformPromoted: string;
  failed: string;
  crashed: string;
  abandoned: string;
  unrecorded: string;
}

export interface ObservatoryViewLabels {
  label: string;
  overview: string;
  cost: string;
  quality: string;
  harness: string;
}

export interface ObservatoryPeriodLabels {
  label: string;
  preset7: string;
  preset30: string;
  preset90: string;
  from: string;
  to: string;
  clamped: string;
  pending: string;
}

export interface ObservatoryOverviewLabels {
  title: string;
  subtitle: string;
  project: string;
  platform: string;
  total: string;
  tasks: string;
  tasksInWork: string;
  tasksStarted: string;
  runs: string;
  inFlight: string;
  settled: string;
  empty: string;
  openInLedger: string;
}

export interface ObservatoryQualityLabels {
  projectsTitle: string;
  flowsTitle: string;
  project: string;
  flow: string;
  flowRuns: string;
  wait: string;
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
  runKind: string;
  flowRuns: string;
  flowLedgerOnly: string;
  node: string;
  all: string;
  drillDown: string;
  latestAttempt: string;
  historicalAttempts: string;
  gates: string;
  hitlWaits: string;
  kind: Record<SignalKind, string>;
  harness: ObservatoryHarnessLabels;
  budget: ObservatoryBudgetLabels;
  costBreakdown: ObservatoryCostBreakdownLabels;
  agentization: ObservatoryAgentizationLabels;
  funnel: ObservatoryFunnelLabels;
  views: ObservatoryViewLabels;
  period: ObservatoryPeriodLabels;
  overview: ObservatoryOverviewLabels;
  quality: ObservatoryQualityLabels;
  /** Hint shown on a free-text field whose draft is not in the URL yet. */
  uncommitted: string;
  // Top-level `runBucket.*` / `runKind.*`: the ledger renders the SAME ten
  // bucket names and the SAME three kind names, so no two surfaces can end up
  // with different words for one value.
  bucket: Record<RunOutcomeBucket, string>;
  runKindName: Record<DeliveryRunKind, string>;
}

export type ObservatorySummaryData = ObservatoryPortfolio | ObservatoryProject;

export interface ObservatoryDashboardProps {
  data: ObservatorySummaryData;
  labels: ObservatoryLabels;
  period: ObservatoryPeriod;
  projectSlug?: string;
  runKind?: ObservatoryRunKind;
}

export interface ObservatoryNodeDrilldownProps {
  detail: ObservatoryNodeDetail;
  labels: ObservatoryLabels;
}

export interface ObservatoryFilterBarProps {
  labels: ObservatoryLabels;
  current: ParsedObservatoryFilters["current"];
  pathname: string;
  /** Portfolio only — the project select's options, already visibility-scoped. */
  projectOptions?: readonly { slug: string; name: string }[];
}

export interface OverviewTableProps {
  table: OverviewTable;
  labels: ObservatoryLabels;
  current: ParsedObservatoryFilters["current"];
  /** Portfolio: absent. Project page: the single project in scope. */
  projectSlug?: string;
  /** Composed by the page (RSC label DTOs stay data-only). */
  liveLabel?: string | null;
}

export interface CorrectionHeatmapProps {
  labels: ObservatoryLabels;
  nodes: readonly ObservatoryNodeSummary[];
  // ADR-177: a drill-down link must land on the Quality view of the SAME
  // period, so every builder needs the effective bounds. REQUIRED — an
  // optional period let a caller silently emit links to a different window.
  period: ObservatoryPeriod;
  projectSlug?: string;
  runKind?: ObservatoryRunKind;
}

export interface ArtifactListProps {
  artifacts: readonly ObservatoryArtifactSummary[];
  labels: ObservatoryLabels;
}

export interface SensorFiringCardProps {
  firing: GateFiringRollup;
  neverFired: readonly NeverFiredFlag[];
  labels: ObservatoryLabels;
  period: ObservatoryPeriod;
  projectSlug?: string;
  runKind?: ObservatoryRunKind;
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
  /**
   * Display names for keys that are not free-form ids. The By-flow breakdown
   * carries `scratch` / `agent` pseudo-rows for the flow-less kinds (ADR-177
   * D5); they are run kinds and read as such.
   */
  keyLabels?: Readonly<Record<string, string>>;
}

export interface CostKindBreakdownProps {
  rows: readonly CostKindRow[];
  labels: ObservatoryLabels;
  locale: string;
}

export interface BudgetKindBreakdownProps {
  rows: readonly BudgetKindRow[];
  labels: ObservatoryLabels;
  locale: string;
}

export interface AgentizationPanelProps {
  data: AgentizationSummary;
  labels: ObservatoryLabels;
  locale: string;
}

export interface AutonomyFunnelCardProps {
  data: ObservatoryFunnel;
  labels: ObservatoryLabels;
  locale: string;
}
