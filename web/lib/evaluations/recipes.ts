import "server-only";

import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";
import type {
  PreflightFlowRevision,
  PreflightMethodRequirements,
  PreflightOverlayCatalog,
  PreflightResult,
} from "@/lib/evaluations/preflight";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { preflightControlledRecipe } from "@/lib/evaluations/preflight";
import { parseControlledRecipe } from "@/lib/evaluations/recipe";

// FIXME(any): schema-module bridge (matches lib/evaluations/studies.ts).
const { evaluationRecipes, evaluationStudies } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-recipes",
  level: process.env.LOG_LEVEL ?? "info",
});

// Create a typed CONTROLLED recipe (M47 D16). Distinct from the M46 legacy
// `createRecipe` (opaque definition): the definition is strict-validated here, so
// a malformed recipe — or one weakening the forced promotion hold — is rejected
// (CONFIG) before any write. Immutable once created: launched participants pin
// its digest, so a controlled recipe is tombstoned + re-added, never rewritten.
export async function createControlledRecipe(
  args: {
    studyId: string;
    projectId: string;
    key: string;
    label: string;
    definition: unknown;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const definition: EvaluationControlledRecipeDefinition =
    parseControlledRecipe(args.definition);

  return d.transaction(async (tx: Db) => {
    const [study] = await tx
      .select({
        id: evaluationStudies.id,
        projectId: evaluationStudies.projectId,
      })
      .from(evaluationStudies)
      .where(eq(evaluationStudies.id, args.studyId));

    if (!study || study.projectId !== args.projectId) {
      throw new MaisterError(
        "PRECONDITION",
        `study ${args.studyId} not found in project ${args.projectId}`,
      );
    }

    const inserted = await tx
      .insert(evaluationRecipes)
      .values({
        studyId: args.studyId,
        key: args.key,
        label: args.label,
        definition: definition as unknown as Record<string, unknown>,
        definitionDigest: contentDigest(definition),
        replicateGroup: definition.replicatePolicy?.groupKey ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted.length) {
      throw new MaisterError(
        "CONFLICT",
        `recipe key already exists in study: ${args.key}`,
      );
    }

    log.info(
      { studyId: args.studyId, recipeKey: args.key },
      "controlled evaluation recipe created",
    );

    return inserted[0];
  });
}

// Injectable contract loaders — the seam between the pure preflight decision core
// and the live Flow/method/runner/capability catalogs. The route supplies the
// real adapters; tests supply stubs so the orchestrator (ownership + wiring) is
// verified without the whole flow-catalog stack (co-evolve: the live projection
// adapters land with the controlled-creation UI in T6.4).
export interface PreflightContractLoaders {
  loadFlowRevision: (args: {
    projectId: string;
    flowRefId: string;
    flowRevisionId: string;
  }) => Promise<PreflightFlowRevision>;
  loadMethodRequirements: (args: {
    projectId: string;
    profileId?: string;
  }) => Promise<PreflightMethodRequirements>;
  loadRunnerCatalog: () => Promise<readonly RunnerCatalogEntry[]>;
  loadOverlayCatalog: (projectId: string) => Promise<PreflightOverlayCatalog>;
}

// Run the input-contract preflight for a controlled recipe against the live
// contracts. Loads + ownership-guards the Study first (a cross-project studyId is
// a 404, never leaked), then delegates the decision to the pure core. No side
// effects — a refusal never forks a worktree or writes a row (D16).
export async function preflightStudyRecipe(
  args: {
    studyId: string;
    projectId: string;
    definition: unknown;
    profileId?: string;
  },
  loaders: PreflightContractLoaders,
  db?: Db,
): Promise<PreflightResult> {
  const d = db ?? getDb();
  const recipe = parseControlledRecipe(args.definition);

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

  const [flow, method, runners, overlayCatalog] = await Promise.all([
    loaders.loadFlowRevision({
      projectId: args.projectId,
      flowRefId: recipe.flow.flowRefId,
      flowRevisionId: recipe.flow.flowRevisionId,
    }),
    loaders.loadMethodRequirements({
      projectId: args.projectId,
      profileId: args.profileId,
    }),
    loaders.loadRunnerCatalog(),
    loaders.loadOverlayCatalog(args.projectId),
  ]);

  const result = preflightControlledRecipe({
    recipe,
    study: { projectId: study.projectId, taskId: study.taskId },
    flow,
    method,
    runners,
    overlayCatalog,
  });

  log.debug(
    {
      studyId: args.studyId,
      ok: result.ok,
      refusals: result.refusals.length,
      warnings: result.warnings.length,
    },
    "controlled recipe preflight evaluated",
  );

  return result;
}
