"use client";

import type { ReactElement } from "react";

import { useTranslations } from "next-intl";

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

export interface PairwiseTournamentView {
  standings: TournamentStandingView[];
  matches: TournamentMatchView[];
  unresolvedMatchCount: number;
}

// The pairwise scoreboard (ADR-147): a ranking table + a per-match list. No
// universal score — a tournament produces a ranking with full provenance. Pure/
// presentational; the parent supplies `labelFor` to blind raw participant ids to
// their human labels.
export function PairwiseScoreboard({
  tournament,
  labelFor,
}: {
  tournament: PairwiseTournamentView;
  labelFor: (participantId: string) => string;
}): ReactElement {
  const t = useTranslations("evaluationsLab");

  function outcomeLabel(match: TournamentMatchView): string {
    if (match.outcome === "a") return labelFor(match.a);
    if (match.outcome === "b") return labelFor(match.b);
    if (match.outcome === "tie") return t("pairwise.tie");

    return t("pairwise.unresolved");
  }

  return (
    <div className="mt-2 flex flex-col gap-3">
      {tournament.unresolvedMatchCount > 0 ? (
        <span className="font-mono text-[11px] text-attention">
          ⚠{" "}
          {t("pairwise.unresolvedBadge", {
            count: tournament.unresolvedMatchCount,
          })}
        </span>
      ) : null}

      <div>
        <h4 className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
          {t("pairwise.ranking")}
        </h4>
        <ol className="grid list-none gap-1 p-0">
          {tournament.standings.map((s) => (
            <li
              key={s.participantId}
              className="flex flex-wrap items-center gap-2 text-[12px] text-ink"
            >
              <span className="font-mono text-mute">#{s.rank}</span>
              <span className="font-semibold">{labelFor(s.participantId)}</span>
              <span className="font-mono text-ink-2">
                {s.wins}-{s.losses}-{s.ties}
              </span>
              <span className="text-mute">
                {s.points} {t("pairwise.points")}
              </span>
              {s.byes > 0 ? (
                <span className="text-mute">
                  · {s.byes} {t("pairwise.byes")}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h4 className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
          {t("pairwise.matches")}
        </h4>
        <ul className="grid list-none gap-1 p-0">
          {tournament.matches.map((m, index) => (
            <li
              key={`${m.a}::${m.b}::${index}`}
              className="flex flex-wrap items-center gap-1.5 text-[12px]"
            >
              <span className="text-ink">{labelFor(m.a)}</span>
              <span className="text-mute">{t("pairwise.vs")}</span>
              <span className="text-ink">{labelFor(m.b)}</span>
              <span className="text-mute">→</span>
              <span
                className={
                  m.outcome === "unresolved" ? "text-attention" : "text-good"
                }
              >
                {outcomeLabel(m)}
              </span>
              <span className="font-mono text-[11px] text-mute">
                ({m.tally.a}/{m.tally.b}/{m.tally.tie})
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
