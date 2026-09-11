import "server-only";

import type { JournalEntry } from "./check-migrations";

// D9 steps 3, 8 and 10: the Stage A/B upgrade is applied in three explicit
// operator stops instead of one chain, so the historical import can run between
// the additive schema and the destructive cut-over. Each stage names the last
// migration it may apply and the migration every earlier stage must have
// committed; the planner refuses rather than guessing when the ledger disagrees.
export const EXECUTION_AB_STAGE_NAMES = [
  "execution-ab-additive",
  "execution-ab-associations",
  "execution-ab-finalize",
] as const;

export type ExecutionAbStage = (typeof EXECUTION_AB_STAGE_NAMES)[number];

export type ExecutionAbStageDefinition = {
  // Last journal tag this stage may apply; null means the canonical migration
  // root, i.e. every remaining migration in the journal.
  readonly boundaryTag: string | null;
  // Every migration at or before this tag must already be committed.
  readonly prerequisiteTag: string | null;
  // Whether the stage applies a migration that removes compatibility state, and
  // therefore requires a drained installation.
  readonly requiresDrainedLegacyWork: boolean;
};

export const EXECUTION_AB_STAGES: Readonly<
  Record<ExecutionAbStage, ExecutionAbStageDefinition>
> = {
  "execution-ab-additive": {
    boundaryTag: "0133_rich_blob",
    prerequisiteTag: null,
    requiresDrainedLegacyWork: false,
  },
  "execution-ab-associations": {
    boundaryTag: "0134_lovely_tarot",
    prerequisiteTag: "0133_rich_blob",
    requiresDrainedLegacyWork: true,
  },
  "execution-ab-finalize": {
    boundaryTag: null,
    prerequisiteTag: "0134_lovely_tarot",
    requiresDrainedLegacyWork: true,
  },
};

export type ExecutionAbStageRefusal =
  | "stage_out_of_order"
  | "ledger_high_water_drift";

export type ExecutionAbStagePlan =
  | {
      outcome: "apply";
      stage: ExecutionAbStage;
      boundaryTag: string | null;
      plannedTags: readonly string[];
      withheldTags: readonly string[];
    }
  | {
      outcome: "satisfied";
      stage: ExecutionAbStage;
      boundaryTag: string | null;
    }
  | {
      outcome: "refused";
      stage: ExecutionAbStage;
      reason: ExecutionAbStageRefusal;
      remediation: string;
      blockedTags: readonly string[];
    };

export function isExecutionAbStage(value: string): value is ExecutionAbStage {
  return (EXECUTION_AB_STAGE_NAMES as readonly string[]).includes(value);
}

function indexOfTag(journal: readonly JournalEntry[], tag: string): number {
  const index = journal.findIndex((entry) => entry.tag === tag);

  if (index < 0) throw new Error(`migration journal does not contain ${tag}`);

  return index;
}

export function planExecutionAbStage(input: {
  stage: ExecutionAbStage;
  journal: readonly JournalEntry[];
  pending: readonly string[];
  ledgerHighWater: number | null;
}): ExecutionAbStagePlan {
  const { stage, journal, pending, ledgerHighWater } = input;
  const definition = EXECUTION_AB_STAGES[stage];
  const boundaryIndex = definition.boundaryTag
    ? indexOfTag(journal, definition.boundaryTag)
    : journal.length - 1;
  const prerequisiteIndex = definition.prerequisiteTag
    ? indexOfTag(journal, definition.prerequisiteTag)
    : -1;
  const pendingEntries = journal.filter((entry) => pending.includes(entry.tag));
  const outOfOrder = pendingEntries.filter(
    (entry) => indexOfTag(journal, entry.tag) <= prerequisiteIndex,
  );

  if (outOfOrder.length > 0) {
    return {
      outcome: "refused",
      stage,
      reason: "stage_out_of_order",
      remediation: `run the earlier stage that commits ${outOfOrder[0].tag} before ${stage}`,
      blockedTags: outOfOrder.map((entry) => entry.tag),
    };
  }

  const plannedEntries = pendingEntries.filter(
    (entry) => indexOfTag(journal, entry.tag) <= boundaryIndex,
  );

  if (plannedEntries.length === 0) {
    return { outcome: "satisfied", stage, boundaryTag: definition.boundaryTag };
  }

  // Drizzle's incremental migrator compares each journal timestamp against the
  // ledger high-water and silently skips anything at or below it, so a planned
  // migration under the watermark would report success without running.
  const drifted =
    ledgerHighWater === null
      ? []
      : plannedEntries.filter((entry) => entry.when <= ledgerHighWater);

  if (drifted.length > 0) {
    return {
      outcome: "refused",
      stage,
      reason: "ledger_high_water_drift",
      remediation: `repair the migration ledger: ${drifted[0].tag} is missing but its journal timestamp is at or below the ledger high-water ${ledgerHighWater}`,
      blockedTags: drifted.map((entry) => entry.tag),
    };
  }

  return {
    outcome: "apply",
    stage,
    boundaryTag: definition.boundaryTag,
    plannedTags: plannedEntries.map((entry) => entry.tag),
    withheldTags: pendingEntries
      .filter((entry) => indexOfTag(journal, entry.tag) > boundaryIndex)
      .map((entry) => entry.tag),
  };
}

// The stage a live database is in, read from the schema it actually carries.
// The importer runs against a half-staged database, which is exactly where the
// migration ledger is least trustworthy, so the committed destructive drops are
// the evidence: 0134 drops the scratch mirror column, 0135 drops the artifact
// projection cursors.
export type DataPlaneStage =
  | "pre-additive"
  | "additive"
  | "associations"
  | "canonical";

export function classifyDataPlaneStage(evidence: {
  importLanes: boolean;
  scratchMirror: boolean;
  artifactProjectionCursors: boolean;
}): DataPlaneStage {
  if (!evidence.importLanes) return "pre-additive";
  if (!evidence.artifactProjectionCursors) return "canonical";

  return evidence.scratchMirror ? "additive" : "associations";
}

export type LegacyImportWindow =
  | { admitted: true }
  | {
      admitted: false;
      reason: "additive_stage_missing" | "already_canonical";
      remediation: string;
    };

export function assessLegacyImportWindow(
  stage: DataPlaneStage,
): LegacyImportWindow {
  if (stage === "pre-additive") {
    return {
      admitted: false,
      reason: "additive_stage_missing",
      remediation:
        "run `db:migrate --stage execution-ab-additive` before importing legacy execution data",
    };
  }

  if (stage === "canonical") {
    return {
      admitted: false,
      reason: "already_canonical",
      remediation:
        "this database already completed the canonical cut-over; repair forward from the retained source and backup instead",
    };
  }

  return { admitted: true };
}
