import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";

import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  find: vi.fn(),
  request: vi.fn(),
  accept: vi.fn(),
  preflight: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/evaluations/launch-authority", () => ({
  createEvaluationTaskLaunchSource: mocks.create,
}));
vi.mock("@/lib/tasks/launch-server-source", () => ({
  findServerTaskLaunch: mocks.find,
}));
vi.mock("@/lib/tasks/launch-intent", () => ({
  serverTaskLaunchRequest: mocks.request,
  acceptServerTaskLaunch: mocks.accept,
}));
vi.mock("@/lib/evaluations/recipes", () => ({
  preflightStudyRecipe: mocks.preflight,
}));
vi.mock("@/lib/evaluations/preflight-loaders", () => ({
  livePreflightLoaders: () => ({}),
}));

import { defaultLaunchRunSeam } from "@/lib/evaluations/launch-seam";

const definition: EvaluationControlledRecipeDefinition = {
  schemaVersion: 1,
  flow: {
    flowRefId: "bugfix",
    flowRevisionId: "revision",
    inputContractDigest: "input",
    artifactContractDigest: "artifact",
  },
  inputs: { taskSnapshotRef: "snapshot", formValues: {} },
  nodeAgentBindings: [],
  slotBindings: {},
  executionPolicy: { preset: "supervised" },
  materializationIntent: {
    packagePins: [],
    capabilityRequirements: [],
    allowedProjectOverlays: [],
  },
  promotionHold: { source: "evaluation_study" },
};
const source = {
  snapshot: {
    kind: "evaluation",
    id: "item",
    projectId: "project",
    taskId: "task",
  },
};
const args = {
  studyId: "study",
  projectId: "project",
  taskId: "task",
  recipeId: "recipe",
  recipeDefinition: definition,
  replicateOrdinal: 1,
  launchKey: "item",
  requestedByUserId: "actor",
};
const seam = defaultLaunchRunSeam({
  actorUserId: "actor",
  authorize: async () => undefined,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ source, definition });
  mocks.find.mockResolvedValue(null);
  mocks.preflight.mockResolvedValue({ ok: true, refusals: [] });
  mocks.request.mockResolvedValue({ taskId: "task", expectedTaskRevision: 1 });
  mocks.accept.mockResolvedValue({
    intentId: "intent",
    state: "queued",
    runId: null,
  });
});

it("fails live preflight before accepting a new canonical intent", async () => {
  mocks.preflight.mockResolvedValue({
    ok: false,
    refusals: [{ code: "flow_untrusted" }],
  });
  await expect(seam(args)).rejects.toMatchObject({ code: "CONFIG" });
  expect(mocks.accept).not.toHaveBeenCalled();
});

it("returns truthful pending acceptance and preserves the forced evaluation promotion hold", async () => {
  await expect(seam(args)).resolves.toEqual({
    accepted: true,
    intentId: "intent",
  });
  expect(mocks.request).toHaveBeenCalledWith(expect.anything(), source, {
    taskId: "task",
    flowId: "bugfix",
    autoPromote: false,
    executionPolicy: { preset: "supervised" },
  });
  expect(mocks.accept).toHaveBeenCalledWith(
    expect.anything(),
    source,
    { taskId: "task", expectedTaskRevision: 1 },
    "item",
  );
});

it("replays a bound run before computing fresh optimistic tokens or preflight", async () => {
  mocks.find.mockResolvedValue({
    intentId: "intent",
    state: "run_bound",
    runId: "run",
  });
  await expect(seam(args)).resolves.toEqual({ runId: "run" });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.preflight).not.toHaveBeenCalled();
});
