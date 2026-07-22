import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

import {
  PairwiseScoreboard,
  type PairwiseTournamentView,
} from "@/components/evaluations/pairwise-scoreboard";

const LABELS: Record<string, string> = {
  p1: "Control",
  p2: "Candidate",
  p3: "Challenger",
};

function labelFor(id: string): string {
  return LABELS[id] ?? id;
}

function tournament(
  overrides: Partial<PairwiseTournamentView> = {},
): PairwiseTournamentView {
  return {
    standings: [
      {
        participantId: "p1",
        rank: 1,
        wins: 2,
        losses: 0,
        ties: 0,
        byes: 0,
        points: 2,
      },
      {
        participantId: "p2",
        rank: 2,
        wins: 1,
        losses: 1,
        ties: 0,
        byes: 0,
        points: 1,
      },
      {
        participantId: "p3",
        rank: 3,
        wins: 0,
        losses: 2,
        ties: 0,
        byes: 0,
        points: 0,
      },
    ],
    matches: [
      { a: "p1", b: "p2", outcome: "a", tally: { a: 2, b: 0, tie: 0 } },
      { a: "p1", b: "p3", outcome: "a", tally: { a: 2, b: 0, tie: 0 } },
      { a: "p2", b: "p3", outcome: "b", tally: { a: 0, b: 2, tie: 0 } },
    ],
    unresolvedMatchCount: 0,
    ...overrides,
  };
}

describe("PairwiseScoreboard", () => {
  it("renders the ranking by rank with participant labels (not raw ids)", () => {
    const markup = renderToStaticMarkup(
      createElement(PairwiseScoreboard, { tournament: tournament(), labelFor }),
    );

    expect(markup).toContain("pairwise.ranking");
    expect(markup).toContain("#1");
    expect(markup).toContain("Control");
    expect(markup).toContain("Candidate");
    expect(markup).toContain("Challenger");
    expect(markup).not.toContain("p1");
  });

  it("renders each match with its outcome and tally", () => {
    const markup = renderToStaticMarkup(
      createElement(PairwiseScoreboard, { tournament: tournament(), labelFor }),
    );

    expect(markup).toContain("pairwise.matches");
    expect(markup).toContain("pairwise.vs");
    expect(markup).toContain("(2/0/0)");
  });

  it("renders tie + unresolved outcomes and the unresolved badge (mixed statuses)", () => {
    const markup = renderToStaticMarkup(
      createElement(PairwiseScoreboard, {
        tournament: tournament({
          matches: [
            { a: "p1", b: "p2", outcome: "tie", tally: { a: 1, b: 1, tie: 0 } },
            {
              a: "p1",
              b: "p3",
              outcome: "unresolved",
              tally: { a: 1, b: 0, tie: 0 },
            },
          ],
          unresolvedMatchCount: 1,
        }),
        labelFor,
      }),
    );

    expect(markup).toContain("pairwise.tie");
    expect(markup).toContain("pairwise.unresolved");
    expect(markup).toContain("pairwise.unresolvedBadge");
    expect(markup).toMatch(/count&quot;:1|count":1/);
  });
});
