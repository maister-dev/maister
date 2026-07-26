import type { LaunchRunSeam } from "@/lib/evaluations/launch-batch";
import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex-1 (ADR-150 · C): the default seam re-runs live preflight fail-closed
// immediately before the first launch side effect, and threads the recipe's
// pinned flow revision + frozen form inputs into launchRun. Wiring-level unit
// test — launchRun and the preflight assembly are mocked; the honored pin and
// form-artifact write are proven by the launchRun integration suite.

const launchRunMock = vi.fn(async () => ({
  runId: "run-1",
  status: "Pending",
}));
const preflightMock = vi.fn(async () => ({
  ok: true,
  refusals: [],
  warnings: [],
}));

vi.mock("@/lib/services/runs", () => ({
  launchRun: (...args: unknown[]) =>
    (launchRunMock as (...a: unknown[]) => unknown)(...args),
}));
vi.mock("@/lib/evaluations/recipes", () => ({
  preflightStudyRecipe: (...args: unknown[]) =>
    (preflightMock as (...a: unknown[]) => unknown)(...args),
}));
vi.mock("@/lib/evaluations/preflight-loaders", () => ({
  livePreflightLoaders: vi.fn(() => ({}) as never),
}));

import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";

function recipeDefinition(
  overrides: Partial<EvaluationControlledRecipeDefinition> = {},
): EvaluationControlledRecipeDefinition {
  return {
    schemaVersion: 1,
    flow: {
      flowRefId: "bugfix",
      flowRevisionId: "rev-pinned",
      inputContractDigest: "icd",
      artifactContractDigest: "acd",
    },
    inputs: { taskSnapshotRef: "snap", formValues: {} },
    nodeAgentBindings: [],
    slotBindings: {
      "session:main": { mode: "runner", runnerId: "runner-1" },
      "consensus:judge-a": { mode: "runner", runnerId: "runner-2" },
    },
    executionPolicy: { preset: "supervised" },
    materializationIntent: {
      packagePins: [],
      capabilityRequirements: [],
      allowedProjectOverlays: [],
    },
    promotionHold: { source: "evaluation_study" },
    ...overrides,
  } as EvaluationControlledRecipeDefinition;
}

function seamArgs(definition: EvaluationControlledRecipeDefinition) {
  return {
    studyId: "study-1",
    projectId: "project-1",
    taskId: "task-1",
    recipeId: "recipe-1",
    recipeDefinition: definition,
    replicateOrdinal: 1,
    launchKey: "item-1",
    requestedByUserId: null,
  };
}

const ctx = {
  actorUserId: "user-1",
  authorize: async () => undefined,
} as never;

beforeEach(() => {
  launchRunMock.mockClear();
  preflightMock.mockClear();
  preflightMock.mockResolvedValue({ ok: true, refusals: [], warnings: [] });
});

describe("defaultLaunchRunSeam (Codex-1)", () => {
  it("re-runs live preflight and fails closed on a hard refusal BEFORE any launch side effect", async () => {
    preflightMock.mockResolvedValue({
      ok: false,
      refusals: [{ code: "flow_untrusted", message: "untrusted" }],
      warnings: [],
    } as never);
    const seam: LaunchRunSeam = defaultLaunchRunSeam(ctx);

    await expect(seam(seamArgs(recipeDefinition()))).rejects.toMatchObject({
      code: "CONFIG",
    });
    expect(launchRunMock).not.toHaveBeenCalled();
    expect(preflightMock).toHaveBeenCalledWith(
      expect.objectContaining({
        studyId: "study-1",
        projectId: "project-1",
      }),
      expect.anything(),
    );
  });

  it("threads the recipe's pinned flow revision + form inputs into launchRun", async () => {
    const definition = recipeDefinition({
      inputs: {
        taskSnapshotRef: "snap",
        formValues: { environment: "staging" },
      },
    });
    const seam: LaunchRunSeam = defaultLaunchRunSeam(ctx);

    const result = await seam(seamArgs(definition));

    expect(result).toEqual({ runId: "run-1" });
    expect(launchRunMock).toHaveBeenCalledTimes(1);
    const [input] = launchRunMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];

    expect(input).toMatchObject({
      taskId: "task-1",
      allowConcurrent: true,
      autoPromote: false,
      evaluationStudyId: "study-1",
      evaluationBatchItemId: "item-1",
      evaluationFlowRevisionId: "rev-pinned",
      evaluationFormInputs: { environment: "staging" },
      // Only `session:` slots thread as runner overrides (unchanged behavior).
      sessionRunnerOverrides: { main: "runner-1" },
    });
  });

  it("omits evaluationFormInputs when the recipe carries no form values", async () => {
    const seam: LaunchRunSeam = defaultLaunchRunSeam(ctx);

    await seam(seamArgs(recipeDefinition()));

    const [input] = launchRunMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];

    expect(input).not.toHaveProperty("evaluationFormInputs");
    expect(input).toMatchObject({ evaluationFlowRevisionId: "rev-pinned" });
  });
});
