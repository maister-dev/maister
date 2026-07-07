import type { ExperimentMaterializationDelta } from "@/lib/experiments/types";

import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  buildExperimentMaterializationSelection,
  loadExperimentOverlayForRun,
  persistExperimentMaterializationDelta,
} from "@/lib/experiments/materialization-delta";

type Row = Record<string, unknown>;
type State = {
  experiments: Row[];
  experimentRuns: Row[];
  updates: Array<{ tableName: string; values: Row }>;
};

function fakeDb(state: State) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const tableName = getTableName(table as never);
        const rows =
          tableName === "experiments"
            ? state.experiments
            : tableName === "experiment_runs"
              ? state.experimentRuns
              : [];

        return {
          where: () => ({
            limit: () => Promise.resolve(rows),
          }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          state.updates.push({
            tableName: getTableName(table as never),
            values,
          });

          return Promise.resolve();
        },
      }),
    }),
  };
}

function state(overrides: Partial<State> = {}): State {
  return {
    experiments: [
      {
        id: "exp-1",
        variants: [
          {
            key: "with-overlay",
            label: "With overlay",
            config: {
              capabilityOverlay: {
                rules: { add: ["rule-b"] },
                skills: { remove: ["old-skill"], add: ["new-skill"] },
                mcps: { add: ["github"] },
                subagents: { add: ["reviewer"] },
              },
            },
          },
          {
            key: "baseline",
            label: "Baseline",
            config: {},
          },
        ],
      },
    ],
    experimentRuns: [
      {
        experimentId: "exp-1",
        runId: "run-1",
        variantKey: "with-overlay",
      },
    ],
    updates: [],
    ...overrides,
  };
}

describe("experiment materialization delta", () => {
  it("loads the immutable variant overlay for an experiment-member run", async () => {
    await expect(
      loadExperimentOverlayForRun({
        db: fakeDb(state()),
        runId: "run-1",
      }),
    ).resolves.toMatchObject({
      experimentId: "exp-1",
      variantKey: "with-overlay",
      overlay: {
        skills: { remove: ["old-skill"], add: ["new-skill"] },
      },
    });
  });

  it("returns null for a non-member run", async () => {
    await expect(
      loadExperimentOverlayForRun({
        db: fakeDb(state({ experimentRuns: [] })),
        runId: "plain-run",
      }),
    ).resolves.toBeNull();
  });

  it("merges overlays into resolver selections and records actual changes", () => {
    const result = buildExperimentMaterializationSelection({
      experimentId: "exp-1",
      variantKey: "with-overlay",
      base: {
        selectedMcpIds: [],
        selectedSkillIds: ["base-skill", "old-skill"],
        selectedRuleIds: ["rule-a"],
        selectedAgentDefinitionIds: [],
      },
      overlay: {
        rules: { add: ["rule-b"] },
        skills: { remove: ["old-skill"], add: ["new-skill"] },
        mcps: { add: ["github"] },
        subagents: { add: ["reviewer"] },
      },
    });

    expect(result.selection).toEqual({
      selectedMcpIds: ["github"],
      selectedSkillIds: ["base-skill", "new-skill"],
      selectedRuleIds: ["rule-a", "rule-b"],
      selectedAgentDefinitionIds: ["reviewer"],
    });
    expect(result.delta).toEqual({
      experimentId: "exp-1",
      variantKey: "with-overlay",
      added: {
        rules: ["rule-b"],
        skills: ["new-skill"],
        mcps: ["github"],
        subagents: ["reviewer"],
      },
      removed: {
        rules: [],
        skills: ["old-skill"],
        mcps: [],
        subagents: [],
      },
    });
  });

  it("does not record requested removals that were absent from the base selection", () => {
    expect(
      buildExperimentMaterializationSelection({
        experimentId: "exp-1",
        variantKey: "with-overlay",
        base: {
          selectedMcpIds: [],
          selectedSkillIds: ["base-skill"],
          selectedRuleIds: [],
          selectedAgentDefinitionIds: [],
        },
        overlay: { skills: { remove: ["not-selected"] } },
      }).delta.removed.skills,
    ).toEqual([]);
  });

  it("persists the compact delta onto the membership row", async () => {
    const dbState = state();
    const delta: ExperimentMaterializationDelta = {
      experimentId: "exp-1",
      variantKey: "with-overlay",
      added: { rules: [], skills: ["new-skill"], mcps: [], subagents: [] },
      removed: { rules: [], skills: [], mcps: [], subagents: [] },
    };

    await persistExperimentMaterializationDelta({
      db: fakeDb(dbState),
      runId: "run-1",
      delta,
    });

    expect(dbState.updates).toEqual([
      {
        tableName: "experiment_runs",
        values: expect.objectContaining({ materializationDelta: delta }),
      },
    ]);
  });
});
