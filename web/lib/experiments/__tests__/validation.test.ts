import type {
  ExperimentImmutableDefinition,
  ExperimentRubric,
  ExperimentVariant,
} from "@/lib/experiments/types";

import { describe, expect, it } from "vitest";

import { assertExperimentDefinitionImmutable } from "@/lib/experiments/validation";

const variants: ExperimentVariant[] = [
  { key: "a", label: "A", config: { runnerId: "claude" } },
  { key: "b", label: "B", config: { runnerId: "codex" } },
];

const rubric: ExperimentRubric = {
  criteria: [
    {
      id: "correctness",
      label: "Correctness",
      guidance: "Works correctly",
      scale: { min: 1, max: 5 },
      weight: 1,
    },
  ],
};

describe("experiment validation", () => {
  it("allows unchanged immutable experiment definition fields", () => {
    expect(() =>
      assertExperimentDefinitionImmutable(
        { baseBranch: "main", baseCommit: "abc1234", variants, rubric },
        {
          baseBranch: "main",
          baseCommit: "abc1234",
          variants: structuredClone(variants),
          rubric: structuredClone(rubric),
        },
      ),
    ).not.toThrow();
  });

  const mutationCases: Array<[string, ExperimentImmutableDefinition]> = [
    [
      "baseBranch",
      { baseBranch: "release", baseCommit: "abc1234", variants, rubric },
    ],
    [
      "baseCommit",
      { baseBranch: "main", baseCommit: "def5678", variants, rubric },
    ],
    [
      "variants",
      {
        baseBranch: "main",
        baseCommit: "abc1234",
        variants: [variants[0], { ...variants[1], label: "Mutated label" }],
        rubric,
      },
    ],
    [
      "rubric",
      {
        baseBranch: "main",
        baseCommit: "abc1234",
        variants,
        rubric: {
          criteria: [
            {
              id: "correctness",
              label: "Correctness",
              guidance: "Works correctly",
              scale: { min: 1, max: 5 },
              weight: 2,
            },
          ],
        },
      },
    ],
  ];

  it.each(mutationCases)(
    "rejects %s mutation with PRECONDITION",
    (_field, next) => {
      expect(() =>
        assertExperimentDefinitionImmutable(
          { baseBranch: "main", baseCommit: "abc1234", variants, rubric },
          next,
        ),
      ).toThrowError(/immutable experiment definition changed/);
    },
  );
});
