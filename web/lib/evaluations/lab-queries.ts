import "server-only";

import type { Db } from "@/lib/evaluations/db";

import { and, desc, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { getDb } from "@/lib/db/client";
import {
  capabilityRecords,
  evaluationAggregateResults,
  evaluationExecutions,
  evaluationMethodRevisions,
  evaluationProfiles,
  evaluationRecipes,
  flows,
  runs,
  tasks,
} from "@/lib/db/schema";
import { buildFlowContractProjection } from "@/lib/evaluations/preflight-loaders";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import { controlledRecipesEnabled } from "@/lib/evaluations/launch-batch";

const log = pino({
  name: "evaluations-lab-queries",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface TournamentStandingView {
  participantId: string;
  rank: number;
  wins: number;
  losses: number;
  ties: number;
  byes: number;
  points: number;
}

export interface TournamentMatchView {
  a: string;
  b: string;
  outcome: "a" | "b" | "tie" | "unresolved";
  tally: { a: number; b: number; tie: number };
}

export interface StudyExecutionView {
  id: string;
  status: string;
  terminalReason: string | null;
  methodQualifiedId: string | null;
  requestedAt: string | null;
  // The deterministic aggregate scoreboard (display-rounded), null until computed.
  aggregate: {
    displayTotal: number | null;
    perCriterion: Array<{ criterionId: string; displayValue: number | null }>;
    dispersion: Record<string, unknown> | null;
    warnings: string[] | null;
  } | null;
  // Pairwise tournament ranking + per-match outcomes (ADR-147), null for scalar
  // methods. Drives the scoreboard's pairwise branch.
  tournament: {
    standings: TournamentStandingView[];
    matches: TournamentMatchView[];
    unresolvedMatchCount: number;
  } | null;
}

// The Study Lab execution scoreboard: every Evaluation Execution for a Study with
// its method + latest deterministic aggregate (display values only — never raw
// attempts or rationales). Ordered newest-first.
export async function listStudyExecutions(
  studyId: string,
  db?: Db,
): Promise<StudyExecutionView[]> {
  const d = db ?? getDb();
  const rows = await d
    .select({
      id: evaluationExecutions.id,
      status: evaluationExecutions.status,
      terminalReason: evaluationExecutions.terminalReason,
      requestedAt: evaluationExecutions.requestedAt,
      methodQualifiedId: evaluationMethodRevisions.qualifiedId,
    })
    .from(evaluationExecutions)
    .leftJoin(
      evaluationMethodRevisions,
      eq(evaluationExecutions.methodRevisionId, evaluationMethodRevisions.id),
    )
    .where(eq(evaluationExecutions.studyId, studyId))
    .orderBy(desc(evaluationExecutions.requestedAt));

  const result: StudyExecutionView[] = [];

  for (const row of rows) {
    const [agg] = await d
      .select({
        algorithmId: evaluationAggregateResults.algorithmId,
        displayValues: evaluationAggregateResults.displayValues,
        calculations: evaluationAggregateResults.calculations,
        dispersion: evaluationAggregateResults.dispersion,
        warnings: evaluationAggregateResults.warnings,
      })
      .from(evaluationAggregateResults)
      .where(eq(evaluationAggregateResults.executionId, row.id))
      .orderBy(desc(evaluationAggregateResults.revision))
      .limit(1);

    const isTournament = agg?.algorithmId === "pairwise_tournament";
    const dv = agg?.displayValues as Record<string, unknown> | undefined;

    result.push({
      id: row.id,
      status: row.status,
      terminalReason: row.terminalReason ?? null,
      methodQualifiedId: row.methodQualifiedId ?? null,
      requestedAt:
        row.requestedAt instanceof Date ? row.requestedAt.toISOString() : null,
      aggregate: agg
        ? {
            displayTotal:
              (agg.displayValues?.displayTotal as number | undefined) ?? null,
            perCriterion: (agg.displayValues?.perCriterion ?? []) as Array<{
              criterionId: string;
              displayValue: number | null;
            }>,
            dispersion: agg.dispersion ?? null,
            warnings: agg.warnings ?? null,
          }
        : null,
      tournament:
        agg && isTournament
          ? {
              standings: (dv?.standings ?? []) as TournamentStandingView[],
              matches: ((agg.calculations as { matches?: unknown })?.matches ??
                []) as TournamentMatchView[],
              unresolvedMatchCount:
                (dv?.unresolvedMatchCount as number | undefined) ?? 0,
            }
          : null,
    });
  }

  return result;
}

export interface EnabledProfileView {
  id: string;
  name: string;
}

// The enabled Evaluation Profiles a project user may launch a Study evaluation
// through (names + ids only). Disabled profiles are excluded — a disabled
// dependency blocks new starts (D8).
export async function listEnabledProfiles(
  db?: Db,
): Promise<EnabledProfileView[]> {
  const d = db ?? getDb();

  return d
    .select({ id: evaluationProfiles.id, name: evaluationProfiles.name })
    .from(evaluationProfiles)
    .where(eq(evaluationProfiles.enabled, true))
    .orderBy(evaluationProfiles.name);
}

export interface ComparableRunView {
  id: string;
  status: string;
  startedAt: string | null;
}

// Flow Runs for the Study's task that may be selected as OBSERVED participants
// (D3 — a scratch/agent run is not a task attempt). The service re-validates
// same-task/project + run kind at add time; this only lists candidates.
export async function listComparableTaskRuns(
  taskId: string,
  db?: Db,
): Promise<ComparableRunView[]> {
  const d = db ?? getDb();
  const rows = await d
    .select({
      id: runs.id,
      status: runs.status,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.runKind, "flow")))
    .orderBy(desc(runs.startedAt));

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    startedAt: r.startedAt instanceof Date ? r.startedAt.toISOString() : null,
  }));
}

// ── Controlled-launch context (ADR-150 T1.4) ─────────────────────────────────
// The Study Lab launch dialog builds inline controlled recipes client-side, but
// the load-bearing parts of a recipe — the pinned Flow revision and its
// input/artifact contract digests — MUST be server-derived: the freeze-time and
// preflight-time digests are only byte-identical when both come from the ONE
// assembler (`buildFlowContractProjection`). So the server resolves the recipe
// scaffold here and the client only fills the parity axes (runner, pin, policy,
// overlay). The client can never fabricate a digest that would pass preflight.

// The stable slot/consensus keys + pinned revision the client stamps onto every
// inline recipe. `null` ⇒ the study's task has no launchable Flow (launch off).
export interface ControlledFlowScaffold {
  flowRefId: string;
  flowRevisionId: string;
  inputContractDigest: string;
  artifactContractDigest: string;
  // A stable, opaque ref to the task snapshot (the taskId — schema requires a
  // non-empty string; nothing dereferences it in M47's first scope).
  taskSnapshotRef: string;
  slotKeys: string[];
  requiredSlotKeys: string[];
}

// A launchable host runner for the per-slot hard-pin picker. NO env/provider —
// those carry credentials and never cross the RSC boundary.
export interface ControlledRunnerOption {
  id: string;
  capabilityAgent: string;
  model: string;
  ready: boolean;
}

// A previously-created recipe the operator may re-launch in a new batch (D3).
export interface ControlledRecipeOption {
  id: string;
  key: string;
  label: string;
}

export interface ControlledOverlayCatalog {
  rules: string[];
  skills: string[];
  mcps: string[];
  subagents: string[];
}

export interface ControlledLaunchContext {
  // Kill switch (`MAISTER_CONTROLLED_RECIPES_ENABLED`). Off ⇒ the create refuses
  // CONFIG server-side, so the dialog disables launch with a reason.
  enabled: boolean;
  // Study status admits a launch (draft|open). decided|archived ⇒ launch hidden.
  launchable: boolean;
  taskId: string | null;
  scaffold: ControlledFlowScaffold | null;
  runnerOptions: ControlledRunnerOption[];
  overlayCatalog: ControlledOverlayCatalog;
  existingRecipes: ControlledRecipeOption[];
}

const LAUNCHABLE_STUDY_STATUSES = new Set(["draft", "open"]);

// Resolve the study task's enabled Flow revision into the recipe scaffold. Honest
// absence: a task with no flow, a flow with no enabled revision, or an
// unresolvable projection (missing revision / unparseable manifest) degrades to
// `null` + a WARN — never a fabricated scaffold that would fail preflight loudly.
async function resolveFlowScaffold(
  projectId: string,
  taskId: string | null,
  d: Db,
): Promise<ControlledFlowScaffold | null> {
  if (!taskId) return null;

  const [task] = await d
    .select({ flowId: tasks.flowId })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (!task?.flowId) return null;

  const [flow] = await d
    .select({
      flowRefId: flows.flowRefId,
      enabledRevisionId: flows.enabledRevisionId,
    })
    .from(flows)
    .where(eq(flows.id, task.flowId));

  if (!flow?.enabledRevisionId) return null;

  try {
    const projection = await buildFlowContractProjection(
      {
        projectId,
        flowRefId: flow.flowRefId,
        flowRevisionId: flow.enabledRevisionId,
      },
      d,
    );

    return {
      flowRefId: projection.flowRefId,
      flowRevisionId: projection.flowRevisionId,
      inputContractDigest: computeInputContractDigest(projection),
      artifactContractDigest: computeArtifactContractDigest(projection),
      taskSnapshotRef: taskId,
      slotKeys: projection.slotKeys,
      requiredSlotKeys: projection.requiredSlotKeys,
    };
  } catch (err) {
    log.warn(
      { projectId, taskId, err: (err as Error).message },
      "controlled-launch flow scaffold unavailable",
    );

    return null;
  }
}

async function loadOverlayCatalog(
  projectId: string,
  d: Db,
): Promise<ControlledOverlayCatalog> {
  const rows = await d
    .select({
      capabilityRefId: capabilityRecords.capabilityRefId,
      kind: capabilityRecords.kind,
    })
    .from(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.projectId, projectId),
        isNull(capabilityRecords.disabledAt),
      ),
    );

  const catalog: ControlledOverlayCatalog = {
    rules: [],
    skills: [],
    mcps: [],
    subagents: [],
  };

  for (const row of rows) {
    if (row.kind === "rule") catalog.rules.push(row.capabilityRefId);
    else if (row.kind === "skill") catalog.skills.push(row.capabilityRefId);
    else if (row.kind === "mcp") catalog.mcps.push(row.capabilityRefId);
    else if (row.kind === "agent_definition")
      catalog.subagents.push(row.capabilityRefId);
  }

  return catalog;
}

// Everything the Study Lab launch dialog needs to compose + preflight inline
// controlled recipes for a study, resolved server-side (D3, ADR-150 T1.4).
export async function loadControlledLaunchContext(
  args: {
    studyId: string;
    projectId: string;
    taskId: string | null;
    status: string;
  },
  db?: Db,
): Promise<ControlledLaunchContext> {
  const d = db ?? getDb();

  const [scaffold, runners, overlayCatalog, recipeRows] = await Promise.all([
    resolveFlowScaffold(args.projectId, args.taskId, d),
    loadRunnerCatalog(d),
    loadOverlayCatalog(args.projectId, d),
    d
      .select({
        id: evaluationRecipes.id,
        key: evaluationRecipes.key,
        label: evaluationRecipes.label,
      })
      .from(evaluationRecipes)
      .where(
        and(
          eq(evaluationRecipes.studyId, args.studyId),
          isNull(evaluationRecipes.tombstonedAt),
        ),
      )
      .orderBy(desc(evaluationRecipes.createdAt)),
  ]);

  return {
    enabled: controlledRecipesEnabled(),
    launchable: LAUNCHABLE_STUDY_STATUSES.has(args.status),
    taskId: args.taskId,
    scaffold,
    runnerOptions: runners
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id,
        capabilityAgent: r.capabilityAgent,
        model: r.model,
        ready: r.enabled && r.ready,
      })),
    overlayCatalog,
    existingRecipes: recipeRows.map((r) => ({
      id: r.id,
      key: r.key,
      label: r.label,
    })),
  };
}
