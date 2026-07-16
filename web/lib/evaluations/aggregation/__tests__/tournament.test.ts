import type { MatchVerdicts } from "@/lib/evaluations/aggregation/tournament";

import { describe, expect, it } from "vitest";

import {
  computeTournament,
  generateRoundRobinPairs,
  resolveMatch,
  scheduleRoundRobin,
} from "@/lib/evaluations/aggregation/tournament";

function picks(spec: Array<"a" | "b" | "tie">): MatchVerdicts["picks"] {
  return spec.map((winner, i) => ({ attemptId: `att-${i}`, winner }));
}

describe("generateRoundRobinPairs", () => {
  it("produces every unordered pair once in stable order", () => {
    expect(generateRoundRobinPairs(["a", "b", "c"])).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
  });

  it("returns no pairs for fewer than two participants", () => {
    expect(generateRoundRobinPairs(["a"])).toEqual([]);
  });
});

describe("scheduleRoundRobin", () => {
  it("schedules an even field into rounds with no byes", () => {
    const { rounds, byes } = scheduleRoundRobin(["a", "b", "c", "d"]);

    expect(rounds).toHaveLength(3);
    expect(rounds.flat()).toHaveLength(6);
    expect(Object.values(byes).every((n) => n === 0)).toBe(true);
  });

  it("gives each participant exactly one bye for an odd field", () => {
    const { rounds, byes } = scheduleRoundRobin(["a", "b", "c"]);

    expect(rounds).toHaveLength(3);
    // 3 participants → each plays 2, sits 1: one bye each.
    expect(byes).toEqual({ a: 1, b: 1, c: 1 });
  });
});

describe("resolveMatch", () => {
  it("resolves a clear plurality winner", () => {
    const outcome = resolveMatch(
      { a: "x", b: "y", picks: picks(["a", "a", "b"]) },
      2,
    );

    expect(outcome.outcome).toBe("a");
    expect(outcome.quorumMet).toBe(true);
    expect(outcome.tally).toEqual({ a: 2, b: 1, tie: 0 });
    expect(outcome.includedAttemptIds).toHaveLength(3);
  });

  it("resolves an a==b split to a tie (conservative, deterministic)", () => {
    const outcome = resolveMatch(
      { a: "x", b: "y", picks: picks(["a", "b"]) },
      2,
    );

    expect(outcome.outcome).toBe("tie");
  });

  it("marks a below-quorum match unresolved (incomplete, never guessed)", () => {
    const outcome = resolveMatch({ a: "x", b: "y", picks: picks(["a"]) }, 2);

    expect(outcome.outcome).toBe("unresolved");
    expect(outcome.quorumMet).toBe(false);
  });
});

describe("computeTournament", () => {
  it("ranks a decisive round-robin by points with provenance", () => {
    // a beats b and c; b beats c → a=2w, b=1w1l, c=2l.
    const result = computeTournament({
      participants: ["a", "b", "c"],
      quorum: 1,
      matches: [
        { a: "a", b: "b", picks: picks(["a"]) },
        { a: "a", b: "c", picks: picks(["a"]) },
        { a: "b", b: "c", picks: picks(["a"]) },
      ],
    });

    const byId = new Map(result.standings.map((s) => [s.participantId, s]));

    expect(byId.get("a")!.rank).toBe(1);
    expect(byId.get("a")!.wins).toBe(2);
    expect(byId.get("b")!.rank).toBe(2);
    expect(byId.get("c")!.rank).toBe(3);
    expect(byId.get("c")!.losses).toBe(2);
    // Provenance: exact match outcomes are carried in the result.
    expect(result.matches).toHaveLength(3);
    expect(result.unresolvedMatchCount).toBe(0);
  });

  it("shares a rank on equal points+wins (standard competition ranking)", () => {
    // a and b both beat c and tie each other → equal record.
    const result = computeTournament({
      participants: ["a", "b", "c"],
      quorum: 1,
      matches: [
        { a: "a", b: "b", picks: picks(["tie"]) },
        { a: "a", b: "c", picks: picks(["a"]) },
        { a: "b", b: "c", picks: picks(["a"]) },
      ],
    });
    const byId = new Map(result.standings.map((s) => [s.participantId, s]));

    expect(byId.get("a")!.rank).toBe(1);
    expect(byId.get("b")!.rank).toBe(1);
    expect(byId.get("c")!.rank).toBe(3);
    expect(byId.get("a")!.ties).toBe(1);
  });

  it("counts an unresolved match without changing standings", () => {
    const result = computeTournament({
      participants: ["a", "b"],
      quorum: 3,
      matches: [{ a: "a", b: "b", picks: picks(["a", "a"]) }],
    });

    expect(result.unresolvedMatchCount).toBe(1);
    expect(result.standings.every((s) => s.wins === 0 && s.losses === 0)).toBe(
      true,
    );
  });

  it("folds byes into standings without awarding points", () => {
    const result = computeTournament({
      participants: ["a", "b", "c"],
      quorum: 1,
      byes: { a: 1, b: 1, c: 1 },
      matches: [{ a: "a", b: "b", picks: picks(["a"]) }],
    });
    const byId = new Map(result.standings.map((s) => [s.participantId, s]));

    expect(byId.get("a")!.byes).toBe(1);
    // A bye alone yields no points.
    expect(byId.get("c")!.points).toBe(0);
  });
});
