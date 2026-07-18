import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { PreflightContractLoaders } from "@/lib/evaluations/recipes";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  evaluationHumanVerdicts,
  evaluationParticipants,
  evaluationRecipes,
  evaluationStandardizedRecipes,
  evaluationStudies,
} from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { preflightControlledRecipe } from "@/lib/evaluations/preflight";
import { parseControlledRecipe } from "@/lib/evaluations/recipe";

const log = pino({
  name: "evaluations-standardization",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface StandardizationEligibility {
  eligible: boolean;
  refusals: string[];
  winnerParticipantId: string | null;
  sourceRecipeId: string | null;
  sourceVerdictId: string | null;
  recipeDefinition: Record<string, unknown> | null;
}

// Load the conclusive (latest, non-superseded) human verdict for a Study.
async function latestConclusiveVerdict(
  studyId: string,
  d: Db,
): Promise<typeof evaluationHumanVerdicts.$inferSelect | null> {
  const rows = await d
    .select()
    .from(evaluationHumanVerdicts)
    .where(eq(evaluationHumanVerdicts.studyId, studyId))
    .orderBy(desc(evaluationHumanVerdicts.createdAt));
  const superseded = new Set(
    rows
      .map((r) => r.supersedesId)
      .filter((id): id is string => typeof id === "string"),
  );

  return rows.find((r) => !superseded.has(r.id)) ?? null;
}

// PHASE 1 (preview): is a Study's winning recipe eligible to standardize? NO side
// effects. Requires a conclusive `winner` verdict citing a LAUNCHED participant
// with a typed controlled recipe, and a FRESH compatibility/trust preflight that
// passes. Every failure is a stable refusal code (localized at the UI). This is a
// read + pure-check path — a judge token never reaches it (route enforces admin).
export async function checkStandardizationEligible(
  args: { studyId: string; projectId: string },
  loaders: PreflightContractLoaders,
  db?: Db,
): Promise<StandardizationEligibility> {
  const d = db ?? getDb();
  const refusals: string[] = [];

  const [study] = await d
    .select({
      id: evaluationStudies.id,
      projectId: evaluationStudies.projectId,
      taskId: evaluationStudies.taskId,
    })
    .from(evaluationStudies)
    .where(
      and(
        eq(evaluationStudies.id, args.studyId),
        eq(evaluationStudies.projectId, args.projectId),
      ),
    );

  if (!study) {
    throw new MaisterError("PRECONDITION", `study not found: ${args.studyId}`);
  }

  const verdict = await latestConclusiveVerdict(args.studyId, d);
  const empty: StandardizationEligibility = {
    eligible: false,
    refusals,
    winnerParticipantId: null,
    sourceRecipeId: null,
    sourceVerdictId: null,
    recipeDefinition: null,
  };

  if (!verdict || verdict.outcome !== "winner") {
    refusals.push("no_conclusive_winner");

    return empty;
  }

  const winnerParticipantId = verdict.participantIds[0] ?? null;

  if (!winnerParticipantId) {
    refusals.push("no_conclusive_winner");

    return empty;
  }

  // Scoped by the verdict's study — a verdict citing a participant of another
  // study/project must never pull that recipe into THIS project's default.
  const [participant] = await d
    .select({
      id: evaluationParticipants.id,
      sourceType: evaluationParticipants.sourceType,
      recipeId: evaluationParticipants.recipeId,
    })
    .from(evaluationParticipants)
    .where(
      and(
        eq(evaluationParticipants.id, winnerParticipantId),
        eq(evaluationParticipants.studyId, verdict.studyId),
      ),
    );

  if (!participant) {
    throw new MaisterError(
      "CONFIG",
      `verdict ${verdict.id} cites participant ${winnerParticipantId} outside study ${verdict.studyId}`,
    );
  }

  if (participant.sourceType !== "launched" || !participant.recipeId) {
    // An observed winner has no reproducible recipe to standardize.
    refusals.push("winner_not_launched_recipe");

    return { ...empty, winnerParticipantId };
  }

  const [recipe] = await d
    .select({
      id: evaluationRecipes.id,
      definition: evaluationRecipes.definition,
      tombstonedAt: evaluationRecipes.tombstonedAt,
    })
    .from(evaluationRecipes)
    .where(
      and(
        eq(evaluationRecipes.id, participant.recipeId),
        eq(evaluationRecipes.studyId, verdict.studyId),
      ),
    );

  if (!recipe || recipe.tombstonedAt) {
    refusals.push("recipe_unavailable");

    return { ...empty, winnerParticipantId, sourceVerdictId: verdict.id };
  }

  const parsed = parseControlledRecipe(recipe.definition);

  // Fresh preflight against the LIVE contracts (stale dependency / incompatible
  // Flow / untrusted package all refuse here, before any config write).
  const [flow, method, runners, overlayCatalog] = await Promise.all([
    loaders.loadFlowRevision({
      projectId: args.projectId,
      flowRefId: parsed.flow.flowRefId,
      flowRevisionId: parsed.flow.flowRevisionId,
    }),
    loaders.loadMethodRequirements({ projectId: args.projectId }),
    loaders.loadRunnerCatalog(),
    loaders.loadOverlayCatalog(args.projectId),
  ]);
  const preflight = preflightControlledRecipe({
    recipe: parsed,
    study: { projectId: study.projectId, taskId: study.taskId },
    flow,
    method,
    runners,
    overlayCatalog,
  });

  for (const r of preflight.refusals) refusals.push(`preflight:${r.code}`);

  return {
    eligible: refusals.length === 0,
    refusals,
    winnerParticipantId,
    sourceRecipeId: recipe.id,
    sourceVerdictId: verdict.id,
    recipeDefinition: recipe.definition,
  };
}

// Per-(project, slot) advisory lock so concurrent standardize/rollback writers
// are serialized: both allocate coalesce(max(revision),0)+1, so unserialized
// racers compute the same next revision and one dies on the UNIQUE(project,
// slot, revision) insert with a raw 23505. An advisory xact lock (vs a row
// lock) also covers the first-ever revision, where no row exists to lock.
// Held until the top-level tx ends. The namespace constant keeps this lock
// space disjoint from the other advisory-lock users.
const STANDARDIZATION_LOCK_NAMESPACE = 0x65767374;

async function takeStandardizationSlotLock(
  tx: Db,
  projectId: string,
  slot: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${STANDARDIZATION_LOCK_NAMESPACE}::int, hashtext(${`${projectId}:${slot}`})::int)`,
  );
}

async function nextRevision(
  projectId: string,
  slot: string,
  d: Db,
): Promise<number> {
  const [row] = await d
    .select({
      max: sql<number>`coalesce(max(${evaluationStandardizedRecipes.revision}), 0)`,
    })
    .from(evaluationStandardizedRecipes)
    .where(
      and(
        eq(evaluationStandardizedRecipes.projectId, projectId),
        eq(evaluationStandardizedRecipes.slot, slot),
      ),
    );

  return Number(row?.max ?? 0) + 1;
}

// PHASE 2 (confirm): copy a Study's winning recipe into the project-default slot
// as a new standardized revision. RE-CHECKS eligibility (verdict + fresh
// preflight) inside the write path — a dependency that drifted between preview
// and confirm refuses. Append-only + audited (source study/recipe/verdict +
// actor). NO Run status change, no promotion — this is a config default only.
export async function standardizeRecipe(
  args: {
    studyId: string;
    projectId: string;
    slot?: string;
    actorUserId: string;
  },
  loaders: PreflightContractLoaders,
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const slot = args.slot ?? "default";

  return d.transaction(async (tx: Db) => {
    await takeStandardizationSlotLock(tx, args.projectId, slot);

    const eligibility = await checkStandardizationEligible(
      { studyId: args.studyId, projectId: args.projectId },
      loaders,
      tx,
    );

    if (!eligibility.eligible || !eligibility.recipeDefinition) {
      throw new MaisterError(
        "CONFLICT",
        `recipe is not eligible for standardization: ${eligibility.refusals.join(", ")}`,
      );
    }

    const revision = await nextRevision(args.projectId, slot, tx);
    const [row] = await tx
      .insert(evaluationStandardizedRecipes)
      .values({
        projectId: args.projectId,
        slot,
        revision,
        action: "standardize",
        sourceStudyId: args.studyId,
        sourceRecipeId: eligibility.sourceRecipeId,
        sourceVerdictId: eligibility.sourceVerdictId,
        definition: eligibility.recipeDefinition,
        definitionDigest: contentDigest(eligibility.recipeDefinition),
        createdByUserId: args.actorUserId,
      })
      .returning();

    log.info(
      { projectId: args.projectId, slot, revision, studyId: args.studyId },
      "recipe standardized into project default",
    );

    return row;
  });
}

// Get the CURRENT project-default standardized recipe (highest revision) for a
// slot, or null if never standardized.
export async function getCurrentStandardizedRecipe(
  args: { projectId: string; slot?: string },
  db?: Db,
): Promise<Record<string, unknown> | null> {
  const d = db ?? getDb();
  const slot = args.slot ?? "default";
  const [row] = await d
    .select()
    .from(evaluationStandardizedRecipes)
    .where(
      and(
        eq(evaluationStandardizedRecipes.projectId, args.projectId),
        eq(evaluationStandardizedRecipes.slot, slot),
      ),
    )
    .orderBy(desc(evaluationStandardizedRecipes.revision))
    .limit(1);

  return row ?? null;
}

// Roll the project default back to the definition of a PRIOR revision (audited).
// Appends a new `rollback` revision — history is never rewritten. Refuses when
// there is no prior revision to restore.
export async function rollbackStandardization(
  args: { projectId: string; slot?: string; actorUserId: string },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const slot = args.slot ?? "default";

  return d.transaction(async (tx: Db) => {
    await takeStandardizationSlotLock(tx, args.projectId, slot);

    const history = await tx
      .select()
      .from(evaluationStandardizedRecipes)
      .where(
        and(
          eq(evaluationStandardizedRecipes.projectId, args.projectId),
          eq(evaluationStandardizedRecipes.slot, slot),
        ),
      )
      .orderBy(desc(evaluationStandardizedRecipes.revision));

    if (history.length < 2) {
      throw new MaisterError(
        "CONFLICT",
        "no prior standardized revision to roll back to",
      );
    }

    const prior = history[1];
    const revision = Number(history[0].revision) + 1;
    const [row] = await tx
      .insert(evaluationStandardizedRecipes)
      .values({
        projectId: args.projectId,
        slot,
        revision,
        action: "rollback",
        sourceStudyId: prior.sourceStudyId,
        sourceRecipeId: prior.sourceRecipeId,
        sourceVerdictId: prior.sourceVerdictId,
        definition: prior.definition,
        definitionDigest: prior.definitionDigest,
        rolledBackToRevision: prior.revision,
        createdByUserId: args.actorUserId,
      })
      .returning();

    log.info(
      {
        projectId: args.projectId,
        slot,
        revision,
        rolledBackTo: prior.revision,
      },
      "standardized recipe rolled back",
    );

    return row;
  });
}
