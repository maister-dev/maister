import "server-only";

import type { Db } from "@/lib/evaluations/db";
import type { MatchVerdicts, TournamentResult } from "./tournament";

import { and, desc, eq, isNotNull } from "drizzle-orm";

import {
  computeTournament,
  generateRoundRobinPairs,
  PAIRWISE_TOURNAMENT_ALGORITHM,
  scheduleRoundRobin,
} from "./tournament";

import { getDb } from "@/lib/db/client";
import {
  evaluationAggregateResults,
  evaluationJudgeAttempts,
} from "@/lib/db/schema";
import { sha256, stableStringify } from "@/lib/evaluations/digest";
import { frozenExecutionParticipants } from "@/lib/evaluations/frozen-participants";
import { MaisterError } from "@/lib/errors";

// Group the execution's sealed pairwise attempts into per-match verdicts. Only a
// COMPLETED attempt contributes a pick (read from `sealedResult.winner`); a
// non-completed/invalid attempt is excluded, never guessed — an unresolved match
// stays explicit (D11). Every provisioned pair appears even with zero picks so
// the tournament records it as unresolved rather than dropping it.
export async function buildMatchVerdicts(
  executionId: string,
  d: Db,
): Promise<MatchVerdicts[]> {
  const rows = await d
    .select({
      id: evaluationJudgeAttempts.id,
      matchA: evaluationJudgeAttempts.matchA,
      matchB: evaluationJudgeAttempts.matchB,
      status: evaluationJudgeAttempts.status,
      sealedResult: evaluationJudgeAttempts.sealedResult,
    })
    .from(evaluationJudgeAttempts)
    .where(
      and(
        eq(evaluationJudgeAttempts.executionId, executionId),
        isNotNull(evaluationJudgeAttempts.matchA),
      ),
    );

  const byPair = new Map<string, MatchVerdicts>();

  for (const r of rows) {
    if (r.matchA === null || r.matchB === null) continue;
    const key = `${r.matchA}::${r.matchB}`;
    let verdicts = byPair.get(key);

    if (!verdicts) {
      verdicts = { a: r.matchA, b: r.matchB, picks: [] };
      byPair.set(key, verdicts);
    }

    if (r.status === "completed") {
      const winner = (r.sealedResult as { winner?: unknown } | null)?.winner;

      if (winner === "a" || winner === "b" || winner === "tie") {
        verdicts.picks.push({ attemptId: r.id, winner });
      }
    }
  }

  return [...byPair.values()];
}

// Aggregate a pairwise execution into a tournament ranking over the FROZEN
// snapshot participant set (Codex-4) — never live Study membership, so a
// mid-flight add/remove is inert. The expected match matrix is re-derived from
// the frozen set: a recorded verdict group is matched orientation-agnostically
// (a provisioned row keeps its own a/b sides — its picks bind to them); an
// expected pair with NO recorded attempts is synthesized empty so it stays
// explicitly unresolved and the execution can never complete with a missing
// match. Out-of-universe rows (pre-freeze provisioning against mutated
// membership) are dropped by the expected-matrix walk.
export async function computeTournamentForExecution(
  args: { executionId: string; quorum: number },
  d: Db,
): Promise<TournamentResult> {
  const frozen = await frozenExecutionParticipants(args.executionId, d);
  const participants = frozen.map((p) => p.id);
  const recorded = await buildMatchVerdicts(args.executionId, d);

  const pairKey = (a: string, b: string): string =>
    a < b ? `${a}::${b}` : `${b}::${a}`;
  const recordedByPair = new Map<string, MatchVerdicts>();

  for (const match of recorded) {
    const key = pairKey(match.a, match.b);

    if (!recordedByPair.has(key)) recordedByPair.set(key, match);
  }

  const matches = generateRoundRobinPairs(participants).map(
    ([a, b]) => recordedByPair.get(pairKey(a, b)) ?? { a, b, picks: [] },
  );
  const { byes } = scheduleRoundRobin(participants);

  return computeTournament({
    participants,
    matches,
    quorum: args.quorum,
    byes,
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;

  return isUniqueViolation((err as { cause?: unknown }).cause);
}

// Persist a tournament result as an APPEND-ONLY aggregate row (D13), into the
// SAME `evaluation_aggregate_results` ledger the scalar path uses. `displayValues`
// carries the ranking (the scoreboard reads it); `calculations` carries every
// per-match outcome for full provenance. No universal score (pairwise produces a
// ranking, never a scalar total).
export async function persistTournamentAggregate(
  args: {
    executionId: string;
    result: TournamentResult;
    methodDigests: { definitionDigest: string; schemaDigest: string };
  },
  db?: Db,
): Promise<{ id: string; revision: number; digest: string }> {
  const d = db ?? getDb();
  const { result } = args;
  const quorumMet = result.unresolvedMatchCount === 0;

  const includedAttemptIds = result.matches.flatMap(
    (m) => m.includedAttemptIds,
  );
  const inputs = {
    includedAttemptIds,
    algorithmDigest: PAIRWISE_TOURNAMENT_ALGORITHM,
    methodDefinitionDigest: args.methodDigests.definitionDigest,
    methodSchemaDigest: args.methodDigests.schemaDigest,
  };
  const calculations = { matches: result.matches };
  const digest = sha256(
    stableStringify({
      executionId: args.executionId,
      inputs,
      calculations,
      standings: result.standings,
      quorum: { quorum: result.quorum, quorumMet },
    }),
  );

  const nextRevision = async (): Promise<number> => {
    const [prev] = await d
      .select({ revision: evaluationAggregateResults.revision })
      .from(evaluationAggregateResults)
      .where(eq(evaluationAggregateResults.executionId, args.executionId))
      .orderBy(desc(evaluationAggregateResults.revision))
      .limit(1);

    return (prev?.revision ?? 0) + 1;
  };

  const insertRevision = async (revision: number): Promise<{ id: string }> =>
    d.transaction(async (tx: Db) => {
      const [row] = await tx
        .insert(evaluationAggregateResults)
        .values({
          executionId: args.executionId,
          algorithmId: "pairwise_tournament",
          algorithmVersion: "1",
          inputs,
          calculations,
          displayValues: {
            // No universal score — the scoreboard branches on the algorithm and
            // renders standings; a scalar reader sees a null total, not a fake 0.
            displayTotal: null,
            perCriterion: [],
            standings: result.standings,
            unresolvedMatchCount: result.unresolvedMatchCount,
          },
          caps: { totalCapped: false },
          quorum: { quorum: result.quorum, quorumMet },
          exclusions: { excludedAttempts: [] },
          dispersion: {
            level: quorumMet ? "none" : "incomplete",
            signals: { unresolvedMatchCount: result.unresolvedMatchCount },
          },
          warnings: quorumMet ? [] : ["quorum_not_met"],
          digest,
          revision,
        })
        .returning({ id: evaluationAggregateResults.id });

      return row;
    });

  let revision = await nextRevision();

  try {
    const row = await insertRevision(revision);

    return { id: row.id, revision, digest };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  revision = await nextRevision();

  try {
    const row = await insertRevision(revision);

    return { id: row.id, revision, digest };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    throw new MaisterError(
      "CONFLICT",
      `tournament aggregate revision race for execution ${args.executionId} — retry exhausted`,
    );
  }
}
