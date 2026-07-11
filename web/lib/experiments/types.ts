import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

export type ExperimentStatus =
  | "draft"
  | "running"
  | "comparable"
  | "concluded"
  | "abandoned";

export type ExperimentLaunchReason =
  | "initial"
  | "manual_relaunch"
  | "budget_restart";

export type ExperimentMemberRunStatus =
  | "Pending"
  | "Running"
  | "NeedsInput"
  | "NeedsInputIdle"
  | "HumanWorking"
  | "WaitingOnChildren"
  | "Review"
  | "Crashed"
  | "Done"
  | "Abandoned"
  | "Failed";

export type ExperimentOverlayDelta = {
  add?: string[];
  remove?: string[];
};

export type ExperimentCapabilityOverlay = {
  rules?: ExperimentOverlayDelta;
  skills?: ExperimentOverlayDelta;
  mcps?: ExperimentOverlayDelta;
  subagents?: ExperimentOverlayDelta;
};

export type ExperimentVariantConfig = {
  runnerId?: string;
  executionPolicy?: ExecutionPolicy;
  capabilityOverlay?: ExperimentCapabilityOverlay;
  // ADR-129: ephemeral per-run package pin (attachment never mutated).
  packagePin?: { packageInstallId: string };
};

export type ExperimentVariant = {
  key: string;
  label: string;
  config: ExperimentVariantConfig;
};

export type ExperimentRubricCriterion = {
  id: string;
  label: string;
  guidance: string;
  scale: { min: number; max: number };
  weight: number;
  optional?: boolean;
};

export type ExperimentRubric = {
  criteria: ExperimentRubricCriterion[];
};

export type ExperimentHumanVerdict = {
  outcome: "winner" | "tie" | "inconclusive";
  winnerVariantKey?: string;
  comment?: string;
  scores?: Record<string, Record<string, number>>;
  skippedOptionalCriteria?: string[];
};

export type ExperimentJudgeAdvisory = {
  advisoryOrdinal: number;
  agentRunId?: string | null;
  createdAt: string;
  scores: Record<string, Record<string, number>>;
  summary: string;
  confidence?: number;
};

export type ExperimentVerdictEnvelope = {
  human?: ExperimentHumanVerdict;
  judgeAdvisories?: ExperimentJudgeAdvisory[];
};

export type ExperimentDiffFileSummary = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patchHash: string;
};

export type ExperimentMaterializationDelta = {
  experimentId: string;
  variantKey: string;
  added: Record<"rules" | "skills" | "mcps" | "subagents", string[]>;
  removed: Record<"rules" | "skills" | "mcps" | "subagents", string[]>;
};

export type ExperimentImmutableDefinition = {
  baseBranch: string;
  baseCommit: string;
  variants: ExperimentVariant[];
  rubric: ExperimentRubric;
};

export type ExperimentMemberRunProgress = {
  variantKey: string;
  status: ExperimentMemberRunStatus;
};
