import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { EvaluationVerdictOutcome } from "@/lib/evaluations/types";

import { and, desc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { appendEvaluationEvent } from "./dispatcher/events";

import { getDb } from "@/lib/db/client";
import {
  evaluationExecutions,
  evaluationHumanVerdicts,
  evaluationStudies,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { actorForUserId, recordTaskActivity } from "@/lib/social/activity";

const log = pino({
  name: "evaluations-verdicts",
  level: process.env.LOG_LEVEL ?? "info",
});

const CITABLE_STATUSES = ["completed", "partial"] as const;

export interface RecordVerdictArgs {
  studyId: string;
  outcome: EvaluationVerdictOutcome;
  participantIds: string[];
  executionIds: string[];
  noEvaluationEvidenceAck?: boolean;
  rationale?: string | null;
  acknowledgedWarnings?: string[];
  // A correction supersedes a prior verdict; a reason (rationale) is required.
  supersedesId?: string | null;
  createdByUserId: string;
}

// Append-only conclusive human verdict (D14). Judge code can NEVER call this —
// it is wired only to a human session route. A verdict may cite Completed or
// terminal Partial executions only; citing zero executions requires the explicit
// no-evaluation-evidence acknowledgement; a Partial citation requires
// acknowledged comparability warnings. The verdict row + `verdict.recorded`
// event + Study `decided` flip commit in ONE transaction. NO Run status change,
// promotion, or abandon — external side effects are absent.
export async function recordVerdict(
  args: RecordVerdictArgs,
  db?: Db,
): Promise<{ id: string; sequence: number }> {
  const d = db ?? getDb();

  return d.transaction(async (tx: Db) => {
    const [study] = await tx
      .select({
        id: evaluationStudies.id,
        status: evaluationStudies.status,
        taskId: evaluationStudies.taskId,
        projectId: evaluationStudies.projectId,
      })
      .from(evaluationStudies)
      .where(eq(evaluationStudies.id, args.studyId))
      .for("update");

    if (!study) {
      throw new MaisterError(
        "PRECONDITION",
        `evaluation study not found: ${args.studyId}`,
      );
    }
    if (study.status !== "open" && study.status !== "decided") {
      throw new MaisterError(
        "CONFLICT",
        `study ${args.studyId} is ${study.status}; a verdict requires an open (or already-decided) study`,
      );
    }

    if (args.executionIds.length === 0) {
      if (!args.noEvaluationEvidenceAck) {
        throw new MaisterError(
          "CONFIG",
          "a zero-citation verdict requires the explicit no-evaluation-evidence acknowledgement",
        );
      }
    } else {
      const cited = await tx
        .select({
          id: evaluationExecutions.id,
          status: evaluationExecutions.status,
          studyId: evaluationExecutions.studyId,
        })
        .from(evaluationExecutions)
        .where(inArray(evaluationExecutions.id, args.executionIds));

      if (cited.length !== args.executionIds.length) {
        throw new MaisterError(
          "PRECONDITION",
          "one or more cited executions do not exist",
        );
      }

      for (const exec of cited) {
        if (exec.studyId !== args.studyId) {
          throw new MaisterError(
            "CONFIG",
            `cited execution ${exec.id} belongs to a different study`,
          );
        }
        if (!(CITABLE_STATUSES as readonly string[]).includes(exec.status)) {
          throw new MaisterError(
            "CONFIG",
            `cited execution ${exec.id} is ${exec.status}; only Completed or terminal Partial executions can be cited`,
          );
        }
      }

      const hasPartial = cited.some((e) => e.status === "partial");

      if (hasPartial && (args.acknowledgedWarnings ?? []).length === 0) {
        throw new MaisterError(
          "CONFIG",
          "citing a Partial execution requires acknowledging its comparability warnings",
        );
      }
    }

    if (args.supersedesId) {
      const [prior] = await tx
        .select({
          id: evaluationHumanVerdicts.id,
          studyId: evaluationHumanVerdicts.studyId,
        })
        .from(evaluationHumanVerdicts)
        .where(eq(evaluationHumanVerdicts.id, args.supersedesId));

      if (!prior || prior.studyId !== args.studyId) {
        throw new MaisterError(
          "PRECONDITION",
          `superseded verdict not found in study: ${args.supersedesId}`,
        );
      }
      if (!args.rationale || args.rationale.trim().length === 0) {
        throw new MaisterError(
          "CONFIG",
          "a superseding correction requires a rationale",
        );
      }
    }

    const [row] = await tx
      .insert(evaluationHumanVerdicts)
      .values({
        studyId: args.studyId,
        supersedesId: args.supersedesId ?? null,
        outcome: args.outcome,
        participantIds: args.participantIds,
        executionIds: args.executionIds,
        noEvaluationEvidenceAck: args.noEvaluationEvidenceAck ?? false,
        rationale: args.rationale ?? null,
        acknowledgedWarnings: args.acknowledgedWarnings ?? null,
        createdByUserId: args.createdByUserId,
      })
      .returning({ id: evaluationHumanVerdicts.id });

    if (study.status === "open") {
      await tx
        .update(evaluationStudies)
        .set({
          status: "decided",
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(evaluationStudies.id, args.studyId),
            eq(evaluationStudies.status, "open"),
          ),
        );
    }

    const { sequence } = await appendEvaluationEvent(tx, {
      studyId: args.studyId,
      eventType: "verdict.recorded",
      payload: {
        verdictId: row.id,
        outcome: args.outcome,
        citedExecutions: args.executionIds.length,
        supersedes: args.supersedesId ?? null,
      },
    });

    // Social-board mirror (ADR-078): the study's task timeline reflects the
    // conclusion in the SAME transaction as the verdict — bounded metadata only
    // (no rationale/comment body). NOT a Run mutation or promotion (D14).
    await recordTaskActivity(tx, {
      taskId: study.taskId,
      projectId: study.projectId,
      actor: actorForUserId(args.createdByUserId),
      eventKind: "evaluation_decided",
      payload: {
        studyId: args.studyId,
        verdictId: row.id,
        outcome: args.outcome,
        citedExecutions: args.executionIds.length,
        superseded: args.supersedesId ?? null,
      },
    });

    log.info(
      {
        studyId: args.studyId,
        verdictId: row.id,
        outcome: args.outcome,
        supersedes: args.supersedesId ?? null,
      },
      "human verdict recorded",
    );

    return { id: row.id, sequence };
  });
}

export async function listVerdicts(
  studyId: string,
  db?: Db,
): Promise<Record<string, unknown>[]> {
  const d = db ?? getDb();

  return d
    .select()
    .from(evaluationHumanVerdicts)
    .where(eq(evaluationHumanVerdicts.studyId, studyId))
    .orderBy(desc(evaluationHumanVerdicts.createdAt));
}
