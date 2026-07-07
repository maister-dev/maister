import "server-only";

import type {
  ExperimentCapabilityOverlay,
  ExperimentMaterializationDelta,
  ExperimentVariant,
} from "@/lib/experiments/types";

import { eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  applyCapabilityOverlay,
  type CapabilitySelection,
} from "@/lib/experiments/variant-config";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { experiments, experimentRuns } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): pg|sqlite drizzle union.
type Db = any;

type OverlayClass = "rules" | "skills" | "mcps" | "subagents";

const OVERLAY_CLASSES = [
  "rules",
  "skills",
  "mcps",
  "subagents",
] as const satisfies readonly OverlayClass[];

const SELECTION_KEY_BY_CLASS = {
  rules: "selectedRuleIds",
  skills: "selectedSkillIds",
  mcps: "selectedMcpIds",
  subagents: "selectedAgentDefinitionIds",
} as const satisfies Record<OverlayClass, keyof CapabilitySelection>;

const log = pino({
  name: "experiments-materialization",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ExperimentRunOverlay = {
  experimentId: string;
  variantKey: string;
  overlay: ExperimentCapabilityOverlay | undefined;
};

type BuildSelectionArgs = ExperimentRunOverlay & {
  base: CapabilitySelection;
};

function emptyClassMap(): Record<OverlayClass, string[]> {
  return {
    rules: [],
    skills: [],
    mcps: [],
    subagents: [],
  };
}

function setDifference(after: readonly string[], before: readonly string[]) {
  const beforeSet = new Set(before);

  return after.filter((value) => !beforeSet.has(value));
}

export function hasCapabilityOverlayChanges(
  overlay: ExperimentCapabilityOverlay | undefined,
): boolean {
  return OVERLAY_CLASSES.some((cls) => {
    const delta = overlay?.[cls];

    return (delta?.add?.length ?? 0) > 0 || (delta?.remove?.length ?? 0) > 0;
  });
}

export function buildExperimentMaterializationSelection(
  args: BuildSelectionArgs,
): {
  selection: CapabilitySelection;
  delta: ExperimentMaterializationDelta;
} {
  const selection = applyCapabilityOverlay(args.base, args.overlay);
  const added = emptyClassMap();
  const removed = emptyClassMap();

  for (const cls of OVERLAY_CLASSES) {
    const key = SELECTION_KEY_BY_CLASS[cls];

    added[cls] = setDifference(selection[key], args.base[key]);
    removed[cls] = setDifference(args.base[key], selection[key]);
  }

  return {
    selection,
    delta: {
      experimentId: args.experimentId,
      variantKey: args.variantKey,
      added,
      removed,
    },
  };
}

export async function loadExperimentOverlayForRun(args: {
  db: Db;
  runId: string;
}): Promise<ExperimentRunOverlay | null> {
  const memberRows = await args.db
    .select()
    .from(experimentRuns)
    .where(eq(experimentRuns.runId, args.runId))
    .limit(1);
  const member = memberRows.find(
    (row: Record<string, unknown>) => row.runId === args.runId,
  );

  if (!member) return null;

  const experimentId = String(member.experimentId);
  const variantKey = String(member.variantKey);
  const experimentRows = await args.db
    .select()
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .limit(1);
  const experiment = experimentRows.find(
    (row: Record<string, unknown>) => row.id === experimentId,
  );

  if (!experiment) {
    throw new MaisterError(
      "PRECONDITION",
      `experiment not found for run ${args.runId}: ${experimentId}`,
    );
  }

  const variant = (experiment.variants as ExperimentVariant[]).find(
    (candidate) => candidate.key === variantKey,
  );

  if (!variant) {
    throw new MaisterError(
      "CONFIG",
      `experiment ${experimentId} has no immutable variant "${variantKey}" for run ${args.runId}`,
    );
  }

  return {
    experimentId,
    variantKey,
    overlay: variant.config.capabilityOverlay,
  };
}

export async function persistExperimentMaterializationDelta(args: {
  db: Db;
  runId: string;
  nodeAttemptId?: string;
  delta: ExperimentMaterializationDelta;
}): Promise<void> {
  await args.db
    .update(experimentRuns)
    .set({ materializationDelta: args.delta, updatedAt: new Date() })
    .where(eq(experimentRuns.runId, args.runId));

  log.info(
    {
      runId: args.runId,
      nodeAttemptId: args.nodeAttemptId,
      experimentId: args.delta.experimentId,
      variantKey: args.delta.variantKey,
      addedCounts: {
        rules: args.delta.added.rules.length,
        skills: args.delta.added.skills.length,
        mcps: args.delta.added.mcps.length,
        subagents: args.delta.added.subagents.length,
      },
      removedCounts: {
        rules: args.delta.removed.rules.length,
        skills: args.delta.removed.skills.length,
        mcps: args.delta.removed.mcps.length,
        subagents: args.delta.removed.subagents.length,
      },
    },
    "experiment capability overlay materialization delta persisted",
  );
}
