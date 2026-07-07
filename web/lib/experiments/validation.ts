import type { ExperimentImmutableDefinition } from "@/lib/experiments/types";

import { MaisterError } from "@/lib/errors-core";

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }

  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(input).sort()) {
      out[key] = stableJsonValue(input[key]);
    }

    return out;
  }

  return value;
}

function stableJsonString(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return stableJsonString(left) === stableJsonString(right);
}

export function assertExperimentDefinitionImmutable(
  previous: ExperimentImmutableDefinition,
  next: ExperimentImmutableDefinition,
): void {
  const changed =
    previous.baseBranch !== next.baseBranch ||
    previous.baseCommit !== next.baseCommit ||
    !sameJsonValue(previous.variants, next.variants) ||
    !sameJsonValue(previous.rubric, next.rubric);

  if (!changed) return;

  throw new MaisterError(
    "PRECONDITION",
    "immutable experiment definition changed",
    {
      details: {
        baseBranchChanged: previous.baseBranch !== next.baseBranch,
        baseCommitChanged: previous.baseCommit !== next.baseCommit,
        variantsChanged: !sameJsonValue(previous.variants, next.variants),
        rubricChanged: !sameJsonValue(previous.rubric, next.rubric),
      },
    },
  );
}
