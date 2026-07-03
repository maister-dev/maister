import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { appendExperimentAdvisory } from "@/lib/experiments/advisory";
import { DEFAULT_EXPERIMENT_RUBRIC } from "@/lib/experiments/rubric";

const { experiments } = schemaModule as unknown as Record<string, any>;

type Row = Record<string, any>;

type State = {
  experiments: Row[];
  updates: Row[];
};

function selectChain(rows: Row[]): PromiseLike<Row[]> & {
  where: () => ReturnType<typeof selectChain>;
  for: () => Promise<Row[]>;
} {
  return {
    then: (onFulfilled) => Promise.resolve(rows).then(onFulfilled),
    where: () => selectChain(rows),
    for: async () => rows,
  };
}

function fakeDb(state: State): any {
  return {
    select: () => ({
      from: (table: unknown) =>
        selectChain(
          getTableName(table as never) === "experiments"
            ? state.experiments
            : [],
        ),
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: () => {
          state.updates.push(patch);
          if (getTableName(table as never) === "experiments") {
            state.experiments = state.experiments.map((row) => ({
              ...row,
              ...patch,
            }));
          }

          return {
            returning: async () => state.experiments.slice(0, 1),
            then: (onFulfilled: (value: Row[]) => unknown) =>
              Promise.resolve(state.experiments.slice(0, 1)).then(onFulfilled),
          };
        },
      }),
    }),
    transaction: async <T>(fn: (tx: any) => Promise<T>) => fn(fakeDb(state)),
  };
}

function experiment(overrides: Row = {}): Row {
  return {
    id: "exp-1",
    projectId: "project-1",
    status: "comparable",
    variants: [
      { key: "claude", label: "Claude", config: {} },
      { key: "codex", label: "Codex", config: {} },
    ],
    rubric: DEFAULT_EXPERIMENT_RUBRIC,
    verdict: {
      human: { outcome: "winner", winnerVariantKey: "claude" },
      judgeAdvisories: [
        {
          advisoryOrdinal: 1,
          agentRunId: "agent-run-0",
          createdAt: "2026-07-03T10:00:00.000Z",
          scores: { correctness: { claude: 5, codex: 3 } },
          summary: "Earlier advice",
        },
      ],
    },
    ...overrides,
  };
}

describe("appendExperimentAdvisory", () => {
  it("appends advisory-only verdict entries under the experiment lock", async () => {
    const audit = vi.fn(async () => undefined);
    const state: State = { experiments: [experiment()], updates: [] };

    const result = await appendExperimentAdvisory(
      {
        projectId: "project-1",
        experimentId: "exp-1",
        actorLabel: "agent:judge",
        input: {
          agentRunId: "agent-run-1",
          scores: { correctness: { claude: 5, codex: 4 } },
          summary: "Claude is slightly stronger.",
          confidence: 0.7,
        },
        audit,
      },
      fakeDb(state),
    );

    expect(result.advisory).toMatchObject({
      advisoryOrdinal: 2,
      agentRunId: "agent-run-1",
      scores: { correctness: { claude: 5, codex: 4 } },
      summary: "Claude is slightly stronger.",
      confidence: 0.7,
    });
    expect(state.experiments[0].status).toBe("comparable");
    expect(state.experiments[0].verdict.human).toEqual({
      outcome: "winner",
      winnerVariantKey: "claude",
    });
    expect(state.experiments[0].verdict.judgeAdvisories).toHaveLength(2);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("rejects terminal experiments and out-of-scale advisory scores", async () => {
    await expect(
      appendExperimentAdvisory(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorLabel: "agent:judge",
          input: {
            scores: { correctness: { claude: 5, codex: 4 } },
            summary: "Too late.",
          },
        },
        fakeDb({ experiments: [experiment({ status: "concluded" })], updates: [] }),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    await expect(
      appendExperimentAdvisory(
        {
          projectId: "project-1",
          experimentId: "exp-1",
          actorLabel: "agent:judge",
          input: {
            scores: { correctness: { claude: 99 } },
            summary: "Invalid score.",
          },
        },
        fakeDb({ experiments: [experiment()], updates: [] }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});
