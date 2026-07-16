import "server-only";

import pino from "pino";

import { sha256, stableStringify } from "../digest";

import {
  evaluateObjectiveCheck,
  splitProviderVersion,
  type ObjectiveCheckOutcome,
  type ObjectiveCheckSpec,
  type ObjectiveFactSource,
} from "./providers";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): schema-module bridge (matches lib/evaluations/config.ts).
const { evaluationObjectiveCheckRuns, evaluationMetricResults } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-objective",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface ParticipantFacts {
  participantId: string;
  facts: ObjectiveFactSource;
}

export interface ObjectiveRunSummary {
  checkRuns: number;
  metricResults: number;
  // True when at least one `gate`-policy check FAILED — the objective policy
  // then blocks the panel (D11). `unavailable`/`not_run` gate checks do NOT
  // silently pass; the caller decides Partial-vs-Failed per method policy.
  gatingFailed: boolean;
  // gate-policy checks that could not execute (unavailable/not_run/error) —
  // surfaced so the caller applies the method's partial policy honestly.
  gatingUnresolved: number;
}

function isTerminalStatus(status: string): boolean {
  return status === "passed" || status === "failed";
}

// Execute every closed objective check over every participant, writing the
// normalized check-run rows (and metric rows for metric outcomes) in one
// transaction. No package command runs — each provider only reads recorded
// facts (D11). Never converts a missing fact to PASS.
export async function runObjectiveChecks(
  args: {
    executionId: string;
    checks: ObjectiveCheckSpec[];
    participants: ParticipantFacts[];
  },
  db?: Db,
): Promise<ObjectiveRunSummary> {
  const _db = db ?? getDb();
  const summary: ObjectiveRunSummary = {
    checkRuns: 0,
    metricResults: 0,
    gatingFailed: false,
    gatingUnresolved: 0,
  };

  await _db.transaction(async (tx: Db) => {
    for (const check of args.checks) {
      const { checkId, version } = splitProviderVersion(check.provider);

      for (const participant of args.participants) {
        const outcome: ObjectiveCheckOutcome = evaluateObjectiveCheck(
          check,
          participant.facts,
        );

        await tx.insert(evaluationObjectiveCheckRuns).values({
          executionId: args.executionId,
          participantId: participant.participantId,
          checkId,
          checkVersion: version,
          attempt: 1,
          status: outcome.status,
          reason: outcome.reason ?? null,
          outputDigest: sha256(stableStringify(outcome)),
          startedAt: new Date(),
          finishedAt: isTerminalStatus(outcome.status) ? new Date() : null,
        });
        summary.checkRuns += 1;

        if (check.policy === "gate") {
          if (outcome.status === "failed") summary.gatingFailed = true;
          else if (!isTerminalStatus(outcome.status)) {
            summary.gatingUnresolved += 1;
          }
        }

        // Metric-policy checks (or any provider that measured a value) persist a
        // normalized metric row. A metric provider with no value is explicitly
        // `unavailable` — never a 0 (D18).
        if (check.policy === "metric" || outcome.metric) {
          const measured = outcome.metric ?? null;

          await tx.insert(evaluationMetricResults).values({
            executionId: args.executionId,
            participantId: participant.participantId,
            metricId: checkId,
            metricVersion: version,
            status: measured ? "measured" : "unavailable",
            reason: measured ? null : (outcome.reason ?? "no measured value"),
            value: measured?.value ?? null,
            unit: measured?.unit ?? null,
            provenance: { checkId: check.id, provider: check.provider },
          });
          summary.metricResults += 1;
        }
      }
    }
  });

  log.info(
    {
      executionId: args.executionId,
      checkRuns: summary.checkRuns,
      metricResults: summary.metricResults,
      gatingFailed: summary.gatingFailed,
      gatingUnresolved: summary.gatingUnresolved,
    },
    "objective checks executed",
  );

  return summary;
}
