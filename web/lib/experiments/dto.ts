import type {
  ExperimentRubric,
  ExperimentStatus,
  ExperimentVariant,
  ExperimentVerdictEnvelope,
} from "@/lib/experiments/types";

export type ExperimentRow = {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  description?: string | null;
  status: ExperimentStatus;
  baseBranch: string;
  baseCommit: string;
  variants: ExperimentVariant[];
  rubric: ExperimentRubric;
  verdict?: ExperimentVerdictEnvelope | null;
  createdAt: Date | string;
  launchedAt?: Date | string | null;
  comparableAt?: Date | string | null;
  concludedAt?: Date | string | null;
  abandonedAt?: Date | string | null;
};

export type ExperimentListItemDTO = {
  id: string;
  title: string;
  taskId: string;
  taskNumber: number;
  status: ExperimentStatus;
  variantsCount: number;
  baseBranch: string;
  baseCommit: string;
  createdAt: string;
  winnerVariantKey: string | null;
  verdictOutcome: "winner" | "tie" | "inconclusive" | null;
};

export type ExperimentDetailDTO = {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  description: string | null;
  status: ExperimentStatus;
  baseBranch: string;
  baseCommit: string;
  variants: ExperimentVariant[];
  rubric: ExperimentRubric;
  verdict: ExperimentVerdictEnvelope | null;
  createdAt: string;
  launchedAt: string | null;
  comparableAt: string | null;
  concludedAt: string | null;
  abandonedAt: string | null;
};

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  return value;
}

export function experimentToDetailDTO(row: ExperimentRow): ExperimentDetailDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    variants: row.variants,
    rubric: row.rubric,
    verdict: row.verdict ?? null,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    launchedAt: iso(row.launchedAt),
    comparableAt: iso(row.comparableAt),
    concludedAt: iso(row.concludedAt),
    abandonedAt: iso(row.abandonedAt),
  };
}

export function experimentToListItemDTO(
  row: ExperimentRow,
  taskNumber: number,
): ExperimentListItemDTO {
  const humanVerdict = row.verdict?.human;

  return {
    id: row.id,
    title: row.title,
    taskId: row.taskId,
    taskNumber,
    status: row.status,
    variantsCount: row.variants.length,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    winnerVariantKey: humanVerdict?.winnerVariantKey ?? null,
    verdictOutcome: humanVerdict?.outcome ?? null,
  };
}
