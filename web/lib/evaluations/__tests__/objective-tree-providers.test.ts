import type {
  ObjectiveCheckSpec,
  ObjectiveTreeFacts,
} from "@/lib/evaluations/objective/providers";

import { describe, expect, it } from "vitest";

import { evaluateObjectiveCheck } from "@/lib/evaluations/objective/providers";

// ADR-165 AC-39 — the recursive-harness measures, as PURE arms over recorded
// facts. Each provider reads `facts.tree`; none executes anything, and a missing
// fact is `unavailable`, never a 0 (D11/D18: an absent measurement is not a
// measurement of zero, and a harness scored 0 for "no data" would beat a harness
// scored honestly).

// The AC-39 seeded tree, as facts: 3 children hold a valid result, 2 of those
// were collected, one result is invalid, one run crashed, one node was reworked,
// and the root's self-report names ONE collected child and one id that never
// existed.
function treeFacts(over: Partial<ObjectiveTreeFacts> = {}): ObjectiveTreeFacts {
  return {
    childRunCount: 6,
    invalidResultCount: 1,
    validResultChildRunIds: ["c1", "c2", "c3"],
    collectedChildRunIds: ["c1", "c2"],
    consumedChildRunIds: ["c1", "fabricated"],
    reworkCount: 1,
    crashCount: 1,
    treeTokens: 4200,
    treeWallClockMinutes: 12,
    promotionReadiness: "ready",
    ...over,
  };
}

function spec(provider: ObjectiveCheckSpec["provider"]): ObjectiveCheckSpec {
  return { id: "c", provider, policy: "metric" };
}

function metricOf(
  provider: ObjectiveCheckSpec["provider"],
  tree?: ObjectiveTreeFacts,
): Record<string, unknown> | undefined {
  return evaluateObjectiveCheck(spec(provider), tree ? { tree } : {}).metric
    ?.value;
}

describe("the tree measures over the AC-39 seeded tree", () => {
  it("child_run_count@1 counts every descendant", () => {
    expect(metricOf("child_run_count@1", treeFacts())).toEqual({ count: 6 });
  });

  it("result_validation_failures@1 counts invalid rows, result_missing included", () => {
    expect(metricOf("result_validation_failures@1", treeFacts())).toEqual({
      count: 1,
    });
  });

  it("collected_results_ratio@1 is collected ÷ valid = 2/3", () => {
    expect(metricOf("collected_results_ratio@1", treeFacts())).toMatchObject({
      collected: 2,
      valid: 3,
    });
    expect(
      (metricOf("collected_results_ratio@1", treeFacts())?.ratio as number) ??
        0,
    ).toBeCloseTo(2 / 3, 5);
  });

  it("consumed_results_ratio@1 EXCLUDES the fabricated id — 1/3, not 2/3", () => {
    const value = metricOf("consumed_results_ratio@1", treeFacts());

    expect(value).toMatchObject({ consumed: 1, valid: 3 });
    expect((value?.ratio as number) ?? 0).toBeCloseTo(1 / 3, 5);
  });

  it("rework_count@1 and crash_count@1 report the recorded counts", () => {
    expect(metricOf("rework_count@1", treeFacts())).toEqual({ count: 1 });
    expect(metricOf("crash_count@1", treeFacts())).toEqual({ count: 1 });
  });

  it("tree_tokens@1 and tree_wall_clock_minutes@1 carry their units", () => {
    const tokens = evaluateObjectiveCheck(spec("tree_tokens@1"), {
      tree: treeFacts(),
    });
    const wall = evaluateObjectiveCheck(spec("tree_wall_clock_minutes@1"), {
      tree: treeFacts(),
    });

    expect(tokens.metric).toEqual({ value: { tokens: 4200 }, unit: "tokens" });
    expect(wall.metric).toEqual({ value: { minutes: 12 }, unit: "minutes" });
  });

  it("promotion_readiness@1 reports the classifier state, not a verdict", () => {
    expect(metricOf("promotion_readiness@1", treeFacts())).toEqual({
      state: "ready",
    });
    expect(
      evaluateObjectiveCheck(spec("promotion_readiness@1"), {
        tree: treeFacts(),
      }).status,
    ).toBe("passed");
  });
});

describe("absence is unavailable, never zero", () => {
  const TREE_PROVIDERS = [
    "child_run_count@1",
    "result_validation_failures@1",
    "collected_results_ratio@1",
    "consumed_results_ratio@1",
    "rework_count@1",
    "crash_count@1",
    "tree_tokens@1",
    "tree_wall_clock_minutes@1",
    "promotion_readiness@1",
  ] as const;

  it.each(TREE_PROVIDERS)(
    "%s is unavailable with no tree facts",
    (provider) => {
      const outcome = evaluateObjectiveCheck(spec(provider), {});

      expect(outcome.status).toBe("unavailable");
      expect(outcome.metric ?? null).toBeNull();
      expect(outcome.reason ?? "").not.toBe("");
    },
  );

  it("a ratio over ZERO valid results is unavailable — 0/0 is not 0", () => {
    const empty = treeFacts({
      validResultChildRunIds: [],
      collectedChildRunIds: [],
      consumedChildRunIds: [],
    });

    for (const provider of [
      "collected_results_ratio@1",
      "consumed_results_ratio@1",
    ] as const) {
      const outcome = evaluateObjectiveCheck(spec(provider), { tree: empty });

      expect(outcome.status, provider).toBe("unavailable");
      expect(outcome.metric ?? null, provider).toBeNull();
    }
  });

  it("promotion_readiness@1 with no recorded state is unavailable", () => {
    expect(
      evaluateObjectiveCheck(spec("promotion_readiness@1"), {
        tree: treeFacts({ promotionReadiness: null }),
      }).status,
    ).toBe("unavailable");
  });
});

describe("the measures cannot be gamed by a self-report alone", () => {
  // The whole point of the measure: a coordinator that names every child while
  // the engine served it none has USED nothing. Scoring the self-report alone
  // would make the metric a claim-counter.
  it("a root claiming every child, having collected none, scores 0", () => {
    expect(
      metricOf(
        "consumed_results_ratio@1",
        treeFacts({
          collectedChildRunIds: [],
          consumedChildRunIds: ["c1", "c2", "c3"],
        }),
      ),
    ).toMatchObject({ consumed: 0, valid: 3 });
  });

  it("counts only ids that are BOTH engine-collected and self-reported", () => {
    const value = metricOf(
      "consumed_results_ratio@1",
      treeFacts({
        // The engine served c1 and c2; the root claims c2 and c3.
        collectedChildRunIds: ["c1", "c2"],
        consumedChildRunIds: ["c2", "c3"],
      }),
    );

    // Only c2 satisfies both signals — c1 was served but never claimed, c3 was
    // claimed but never served.
    expect(value).toMatchObject({ consumed: 1, valid: 3 });
  });

  // `collected_results_ratio` keeps asking the ENGINE's question alone: it must
  // NOT gain the self-report requirement.
  it("collected_results_ratio still measures what the engine served", () => {
    expect(
      metricOf(
        "collected_results_ratio@1",
        treeFacts({
          collectedChildRunIds: ["c1", "c2"],
          consumedChildRunIds: [],
        }),
      ),
    ).toMatchObject({ collected: 2, valid: 3 });
  });

  it("naming an id that holds NO valid result scores nothing for it", () => {
    expect(
      metricOf(
        "consumed_results_ratio@1",
        treeFacts({ consumedChildRunIds: ["nope", "also-nope"] }),
      ),
    ).toMatchObject({ consumed: 0, valid: 3 });
  });

  it("a duplicated id is counted ONCE", () => {
    expect(
      metricOf(
        "consumed_results_ratio@1",
        treeFacts({ consumedChildRunIds: ["c1", "c1", "c1"] }),
      ),
    ).toMatchObject({ consumed: 1, valid: 3 });
  });
});
