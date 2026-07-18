import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { EvaluationRecipeDefinition } from "@/lib/evaluations/types";

import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  evaluationEvidenceItems,
  evaluationParticipants,
  evaluationRecipes,
  evaluationStudies,
  runs,
  tasks,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

const log = pino({
  name: "evaluations-studies",
  level: process.env.LOG_LEVEL ?? "info",
});

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// --- Study ------------------------------------------------------------------

export async function createStudy(
  args: {
    projectId: string;
    taskId: string;
    title: string;
    purpose?: string | null;
    createdByUserId?: string | null;
  },
  db?: Db,
): Promise<{ id: string } & Record<string, unknown>> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    // taskId is body-controlled selection — join it to the slug-derived project
    // and reject a cross-project selection before any write (identifier trust).
    const [task] = await tx
      .select({ id: tasks.id, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, args.taskId));

    if (!task || task.projectId !== args.projectId) {
      throw new MaisterError(
        "PRECONDITION",
        `task ${args.taskId} not found in project ${args.projectId}`,
      );
    }

    const [study] = await tx
      .insert(evaluationStudies)
      .values({
        projectId: args.projectId,
        taskId: args.taskId,
        title: args.title,
        purpose: args.purpose ?? null,
        status: "draft",
        createdByUserId: args.createdByUserId ?? null,
      })
      .returning();

    log.info(
      { studyId: study.id, projectId: args.projectId, taskId: args.taskId },
      "evaluation study created",
    );

    return study;
  });
}

// --- Readers -----------------------------------------------------------------

export async function listStudies(
  projectId: string,
  db?: Db,
): Promise<Record<string, unknown>[]> {
  const d = db ?? getDb();

  return d
    .select()
    .from(evaluationStudies)
    .where(eq(evaluationStudies.projectId, projectId))
    .orderBy(sql`${evaluationStudies.createdAt} desc`);
}

// Load one study scoped to a project — the ownership guard every study-scoped
// route runs first, so a cross-project studyId is hidden as PRECONDITION (404),
// never leaked (identifier trust: the slug derives the project, the body/URL id
// is validated against it before any read/write).
export async function getStudyForProject(
  args: { studyId: string; projectId: string },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const [study] = await d
    .select()
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

  return study;
}

export async function listParticipants(
  studyId: string,
  db?: Db,
): Promise<Record<string, unknown>[]> {
  const d = db ?? getDb();

  return d
    .select()
    .from(evaluationParticipants)
    .where(eq(evaluationParticipants.studyId, studyId))
    .orderBy(sql`${evaluationParticipants.displayOrder} asc`);
}

// Optimistic-concurrency PATCH: the CAS on `version` is the mutual-exclusion
// guard (skill rule: a transaction is atomicity, not mutual exclusion). A stale
// version returns CONFLICT (409); a missing study returns PRECONDITION.
export async function patchStudy(
  args: {
    studyId: string;
    expectedVersion: number;
    title?: string;
    purpose?: string | null;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();
  const updated = await d
    .update(evaluationStudies)
    .set({
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
      version: sql`${evaluationStudies.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(evaluationStudies.id, args.studyId),
        eq(evaluationStudies.version, args.expectedVersion),
      ),
    )
    .returning();

  if (!updated.length) {
    const [exists] = await d
      .select({ id: evaluationStudies.id })
      .from(evaluationStudies)
      .where(eq(evaluationStudies.id, args.studyId));

    if (!exists) {
      throw new MaisterError(
        "PRECONDITION",
        `study not found: ${args.studyId}`,
      );
    }

    throw new MaisterError(
      "CONFLICT",
      `study ${args.studyId} version mismatch (expected ${args.expectedVersion})`,
    );
  }

  return updated[0];
}

// --- Observed participants ---------------------------------------------------

export async function addObservedParticipants(
  args: {
    studyId: string;
    runIds: string[];
    labels?: Record<string, string>;
  },
  db?: Db,
): Promise<Record<string, unknown>[]> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [study] = await tx
      .select({
        id: evaluationStudies.id,
        projectId: evaluationStudies.projectId,
        taskId: evaluationStudies.taskId,
        status: evaluationStudies.status,
      })
      .from(evaluationStudies)
      .where(eq(evaluationStudies.id, args.studyId));

    if (!study) {
      throw new MaisterError(
        "PRECONDITION",
        `study not found: ${args.studyId}`,
      );
    }

    const result: Record<string, unknown>[] = [];

    for (const runId of dedupe(args.runIds)) {
      const [run] = await tx
        .select({
          id: runs.id,
          taskId: runs.taskId,
          projectId: runs.projectId,
          status: runs.status,
          runKind: runs.runKind,
        })
        .from(runs)
        .where(eq(runs.id, runId));

      if (!run) {
        throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
      }
      // Same task AND project — a cross-task/project Run is rejected before any
      // participant write (AC-01; edge-case matrix).
      if (run.projectId !== study.projectId || run.taskId !== study.taskId) {
        throw new MaisterError(
          "CONFLICT",
          `run ${runId} does not belong to study task/project`,
        );
      }
      // Observed participants must be flow Runs — a scratch/agent run is not a
      // task attempt and cannot be compared as one.
      if (run.runKind !== "flow") {
        throw new MaisterError(
          "PRECONDITION",
          `run ${runId} is not a flow run`,
        );
      }

      // Insert-first with onConflictDoNothing (the partial UNIQUE on live rows
      // is the backstop); an empty result means a live participant already
      // exists → idempotent re-read + return (never a raw 23505).
      const inserted = await tx
        .insert(evaluationParticipants)
        .values({
          studyId: args.studyId,
          runId,
          sourceType: "observed",
          label: args.labels?.[runId] ?? `Run ${runId.slice(0, 8)}`,
          runIdentity: {
            runId,
            taskId: run.taskId,
            status: run.status,
            capturedAt: new Date().toISOString(),
          },
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length) {
        result.push(inserted[0]);
      } else {
        const [existing] = await tx
          .select()
          .from(evaluationParticipants)
          .where(
            and(
              eq(evaluationParticipants.studyId, args.studyId),
              eq(evaluationParticipants.runId, runId),
              isNull(evaluationParticipants.removedAt),
            ),
          );

        if (existing) result.push(existing);
      }
    }

    // Draft -> Open on the first participant (never a lossy Study-level flip:
    // guarded so a concurrent add cannot re-open a decided/archived Study).
    if (study.status === "draft" && result.length > 0) {
      await tx
        .update(evaluationStudies)
        .set({ status: "open", updatedAt: new Date() })
        .where(
          and(
            eq(evaluationStudies.id, args.studyId),
            eq(evaluationStudies.status, "draft"),
          ),
        );
    }

    log.info(
      { studyId: args.studyId, added: result.length },
      "observed participants added",
    );

    return result;
  });
}

// Hard delete only when unreferenced by a sealed evidence item; otherwise
// tombstone so citing evidence keeps a queryable participant (ADR-142 D3).
// LAUNCHED participants are the exception: they may ONLY be tombstoned, cited
// or not — a hard delete would erase the launched-lineage exclusion
// (`isLaunchedLineageRun` reads the row, tombstoned included) and make the run
// auto-promotable/auto-deliverable mid-study (ADR-146 D15).
export async function removeParticipant(
  args: { studyId: string; participantId: string },
  db?: Db,
): Promise<{ tombstoned: boolean }> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [participant] = await tx
      .select({
        id: evaluationParticipants.id,
        sourceType: evaluationParticipants.sourceType,
      })
      .from(evaluationParticipants)
      .where(
        and(
          eq(evaluationParticipants.id, args.participantId),
          eq(evaluationParticipants.studyId, args.studyId),
        ),
      );

    if (!participant) {
      throw new MaisterError(
        "PRECONDITION",
        `participant not found: ${args.participantId}`,
      );
    }

    if (participant.sourceType === "launched") {
      // Keep the FIRST tombstone timestamp on a repeat remove (idempotent).
      await tx
        .update(evaluationParticipants)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(evaluationParticipants.id, args.participantId),
            isNull(evaluationParticipants.removedAt),
          ),
        );

      return { tombstoned: true };
    }

    const [referenced] = await tx
      .select({ id: evaluationEvidenceItems.id })
      .from(evaluationEvidenceItems)
      .where(eq(evaluationEvidenceItems.participantId, args.participantId))
      .limit(1);

    if (referenced) {
      await tx
        .update(evaluationParticipants)
        .set({ removedAt: new Date() })
        .where(eq(evaluationParticipants.id, args.participantId));

      return { tombstoned: true };
    }

    await tx
      .delete(evaluationParticipants)
      .where(eq(evaluationParticipants.id, args.participantId));

    return { tombstoned: false };
  });
}

// --- Recipes -----------------------------------------------------------------

// M46 stores a legacy-shaped variant config as the immutable definition; the
// fully typed controlled recipe (slot bindings, execution policy) is M47.
export async function createRecipe(
  args: {
    studyId: string;
    key: string;
    label: string;
    definition: EvaluationRecipeDefinition;
    replicateGroup?: string | null;
  },
  db?: Db,
): Promise<Record<string, unknown>> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [study] = await tx
      .select({ id: evaluationStudies.id })
      .from(evaluationStudies)
      .where(eq(evaluationStudies.id, args.studyId));

    if (!study) {
      throw new MaisterError(
        "PRECONDITION",
        `study not found: ${args.studyId}`,
      );
    }

    const inserted = await tx
      .insert(evaluationRecipes)
      .values({
        studyId: args.studyId,
        key: args.key,
        label: args.label,
        definition: args.definition,
        definitionDigest: contentDigest(args.definition),
        replicateGroup: args.replicateGroup ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted.length) {
      throw new MaisterError(
        "CONFLICT",
        `recipe key already exists in study: ${args.key}`,
      );
    }

    return inserted[0];
  });
}
