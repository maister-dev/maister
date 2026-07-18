import "server-only";

import type { Db } from "@/lib/evaluations/db";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  evaluationExecutions,
  evaluationSuiteStudies,
  evaluationSuites,
  tasks,
} from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { createStudy } from "@/lib/evaluations/studies";

const log = pino({
  name: "evaluations-suites",
  level: process.env.LOG_LEVEL ?? "info",
});

// Per-tick generation cap — a suite scan never fans out unbounded (capped-scan
// progress, D17). A large task set drains across ticks.
const DEFAULT_SUITE_SCAN_CAP = 25;

export interface EvaluationSuiteDefinition {
  taskIds: string[];
  profileId: string;
  // For a `regression` suite: the package the trigger watches (revision change).
  triggerPackageRef?: string;
}

// Create a versioned Evaluation Suite (the benchmark/regression PARENT that sits
// outside the one-task Study boundary). The definition is digest-addressed; every
// generated Study still binds one project/task (D2).
export async function createSuite(
  args: {
    projectId: string;
    name: string;
    kind?: "scheduled" | "regression";
    definition: EvaluationSuiteDefinition;
    createdByUserId?: string | null;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();

  if (args.definition.taskIds.length === 0) {
    throw new MaisterError("CONFIG", "suite requires at least one task");
  }

  return d.transaction(async (tx: Db) => {
    const taskRows = await tx
      .select({ id: tasks.id, projectId: tasks.projectId })
      .from(tasks)
      .where(inArray(tasks.id, [...new Set(args.definition.taskIds)]));
    const foreign = taskRows.find((t) => t.projectId !== args.projectId);

    if (foreign) {
      throw new MaisterError(
        "PRECONDITION",
        `task ${foreign.id} does not belong to project ${args.projectId}`,
      );
    }
    if (taskRows.length !== new Set(args.definition.taskIds).size) {
      throw new MaisterError(
        "PRECONDITION",
        "one or more suite tasks were not found in the project",
      );
    }

    const [suite] = await tx
      .insert(evaluationSuites)
      .values({
        projectId: args.projectId,
        name: args.name,
        kind: args.kind ?? "scheduled",
        definition: args.definition as unknown as Record<string, unknown>,
        definitionDigest: contentDigest(args.definition),
        createdByUserId: args.createdByUserId ?? null,
      })
      .returning();

    log.info(
      { suiteId: suite.id, projectId: args.projectId, kind: suite.kind },
      "evaluation suite created",
    );

    return suite;
  });
}

// For a `regression` suite, resolve the CURRENT trigger package revision. The
// scan only proceeds when it differs from `lastTriggerRevision` (package-revision-
// change trigger). Injectable so the scan is testable without the package catalog.
export interface SuiteTriggerResolver {
  (triggerPackageRef: string): Promise<string | null>;
}

export interface SuiteScanResult {
  scanned: boolean;
  scanKey: string | null;
  generatedStudyIds: string[];
  skippedTaskIds: string[];
  reason?: "unchanged_revision" | "disabled";
}

// Drive one scan of a suite (the dispatcher tick — the M24 scheduler calls this;
// there is NO second clock, D17). Idempotent per (suite, task, scanKey) via the
// UNIQUE dedup, capped per tick, and poison-safe: a task that fails to generate a
// Study is recorded and skipped, never aborting the whole scan. A `regression`
// suite is a no-op when its trigger revision is unchanged.
export async function runEvaluationSuiteScan(
  suiteId: string,
  deps: { resolveTrigger?: SuiteTriggerResolver; cap?: number } = {},
  db?: Db,
): Promise<SuiteScanResult> {
  const d = db ?? getDb();
  const cap = deps.cap ?? DEFAULT_SUITE_SCAN_CAP;

  const [suite] = await d
    .select()
    .from(evaluationSuites)
    .where(eq(evaluationSuites.id, suiteId));

  if (!suite) {
    throw new MaisterError("PRECONDITION", `suite not found: ${suiteId}`);
  }
  if (!suite.enabled) {
    return {
      scanned: false,
      scanKey: null,
      generatedStudyIds: [],
      skippedTaskIds: [],
      reason: "disabled",
    };
  }

  // Stored as an opaque jsonb Record; createSuite is the only writer and it
  // digest-pins this exact shape.
  const definition = suite.definition as unknown as EvaluationSuiteDefinition;
  let triggerRevision = "scheduled";

  if (suite.kind === "regression" && definition.triggerPackageRef) {
    const current = deps.resolveTrigger
      ? await deps.resolveTrigger(definition.triggerPackageRef)
      : null;

    if (current !== null && current === suite.lastTriggerRevision) {
      return {
        scanned: false,
        scanKey: null,
        generatedStudyIds: [],
        skippedTaskIds: [],
        reason: "unchanged_revision",
      };
    }
    triggerRevision = current ?? "unknown";
  }

  const scanKey = `${suite.version}:${triggerRevision}`;
  const generatedStudyIds: string[] = [];
  const skippedTaskIds: string[] = [];
  // Filter out tasks already generated for THIS scan round BEFORE applying the
  // cap (capped-scan / at-least-once dedup). Capping first would starve tasks
  // past the cap forever: once the first `cap` tasks are linked, every later
  // tick would re-select and skip the same slice.
  const definitionTaskIds = [...new Set(definition.taskIds)];
  const linkedRows = await d
    .select({ taskId: evaluationSuiteStudies.taskId })
    .from(evaluationSuiteStudies)
    .where(
      and(
        eq(evaluationSuiteStudies.suiteId, suiteId),
        eq(evaluationSuiteStudies.scanKey, scanKey),
        inArray(evaluationSuiteStudies.taskId, definitionTaskIds),
      ),
    );
  const linkedTaskIds = new Set(linkedRows.map((row) => row.taskId));
  const taskIds = definitionTaskIds
    .filter((taskId) => !linkedTaskIds.has(taskId))
    .slice(0, cap);

  for (const taskId of taskIds) {
    try {
      const study = await createStudy(
        {
          projectId: suite.projectId,
          taskId,
          title: `${suite.name} — ${scanKey}`,
          purpose: `Suite ${suite.id} scan ${scanKey}`,
        },
        d,
      );

      await d
        .insert(evaluationSuiteStudies)
        .values({
          suiteId,
          studyId: study.id,
          taskId,
          suiteVersion: suite.version,
          scanKey,
        })
        .onConflictDoNothing();

      generatedStudyIds.push(study.id);
    } catch (err) {
      // Poison task: record + continue (never abort the whole scan).
      skippedTaskIds.push(taskId);
      log.warn(
        {
          suiteId,
          taskId,
          err: err instanceof Error ? err.message : String(err),
        },
        "suite scan skipped a task",
      );
    }
  }

  if (suite.kind === "regression") {
    await d
      .update(evaluationSuites)
      .set({ lastTriggerRevision: triggerRevision, updatedAt: new Date() })
      .where(eq(evaluationSuites.id, suiteId));
  }

  log.info(
    {
      suiteId,
      scanKey,
      generated: generatedStudyIds.length,
      skipped: skippedTaskIds.length,
    },
    "evaluation suite scan complete",
  );

  return { scanned: true, scanKey, generatedStudyIds, skippedTaskIds };
}

export interface SuiteScanTickSummary {
  scannedSuites: number;
  skippedSuites: number;
  generatedStudies: number;
  skippedTasks: number;
  failedSuites: number;
}

// The `evaluation_suite_scan` scheduler arm (T7.2's deferred seam): one M24 tick
// scans every enabled suite. Poison-safe per suite — a suite whose scan throws is
// counted and skipped, never aborting the tick (mirrors the per-task contract
// inside runEvaluationSuiteScan). `resolveTrigger` stays injectable; the default
// tick passes none, so a `regression` suite scans once per definition version
// until a package-catalog resolver is threaded through.
export async function runEvaluationSuiteScanTick(
  deps: { resolveTrigger?: SuiteTriggerResolver; cap?: number } = {},
  db?: Db,
): Promise<SuiteScanTickSummary> {
  const d = db ?? getDb();
  const suites = await d
    .select({ id: evaluationSuites.id })
    .from(evaluationSuites)
    .where(eq(evaluationSuites.enabled, true));

  const summary: SuiteScanTickSummary = {
    scannedSuites: 0,
    skippedSuites: 0,
    generatedStudies: 0,
    skippedTasks: 0,
    failedSuites: 0,
  };

  for (const suite of suites) {
    try {
      const result = await runEvaluationSuiteScan(suite.id, deps, d);

      if (result.scanned) {
        summary.scannedSuites += 1;
        summary.generatedStudies += result.generatedStudyIds.length;
        summary.skippedTasks += result.skippedTaskIds.length;
      } else {
        summary.skippedSuites += 1;
      }
    } catch (err) {
      summary.failedSuites += 1;
      log.warn(
        {
          suiteId: suite.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "suite scan tick skipped a suite",
      );
    }
  }

  return summary;
}

export interface SuiteLongitudinalRound {
  scanKey: string;
  suiteVersion: number;
  studyCount: number;
  executionCounts: Record<string, number>;
}

// Longitudinal read model over the suite's IMMUTABLE evaluations (calibration /
// drift). Aggregates by scan round: study count + execution status distribution.
// PRIVATE-DATA-MINIMIZED — counts + status labels + the scan key only; never
// evidence, prompts, diffs, or bodies (rollout metrics contract).
export async function computeSuiteLongitudinal(
  suiteId: string,
  db?: Db,
): Promise<SuiteLongitudinalRound[]> {
  const d = db ?? getDb();

  const links = await d
    .select({
      scanKey: evaluationSuiteStudies.scanKey,
      suiteVersion: evaluationSuiteStudies.suiteVersion,
      studyId: evaluationSuiteStudies.studyId,
    })
    .from(evaluationSuiteStudies)
    .where(eq(evaluationSuiteStudies.suiteId, suiteId));

  if (links.length === 0) return [];

  const studyIds = links.map((l) => l.studyId);
  const executions = await d
    .select({
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
    })
    .from(evaluationExecutions)
    .where(inArray(evaluationExecutions.studyId, studyIds));

  const statusByStudy = new Map<string, string[]>();

  for (const exec of executions) {
    const list = statusByStudy.get(exec.studyId) ?? [];

    list.push(exec.status);
    statusByStudy.set(exec.studyId, list);
  }

  const rounds = new Map<string, SuiteLongitudinalRound>();

  for (const link of links) {
    const key = link.scanKey;
    const round =
      rounds.get(key) ??
      ({
        scanKey: key,
        suiteVersion: link.suiteVersion,
        studyCount: 0,
        executionCounts: {},
      } satisfies SuiteLongitudinalRound);

    round.studyCount += 1;
    for (const status of statusByStudy.get(link.studyId) ?? []) {
      round.executionCounts[status] = (round.executionCounts[status] ?? 0) + 1;
    }
    rounds.set(key, round);
  }

  return [...rounds.values()].sort((a, b) =>
    a.scanKey < b.scanKey ? -1 : a.scanKey > b.scanKey ? 1 : 0,
  );
}
