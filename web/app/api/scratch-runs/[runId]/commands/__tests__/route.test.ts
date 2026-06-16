import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../route";

import { MaisterError } from "@/lib/errors-core";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  readScratchAvailableCommands: vi.fn(),
}));

const state: { run: Record<string, unknown> | null } = { run: null };

const fakeDb = {
  select: () => ({
    from: () => ({
      where: async () => (state.run ? [state.run] : []),
    }),
  }),
};

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/scratch-runs/available-commands", () => ({
  readScratchAvailableCommands: mocks.readScratchAvailableCommands,
}));

const ctx = { params: Promise.resolve({ runId: "run-1" }) };

function req(): Request {
  return new Request("http://localhost/api/scratch-runs/run-1/commands");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.run = { projectId: "proj-1", runKind: "scratch" };
  mocks.requireActiveSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.requireProjectAction.mockResolvedValue(undefined);
  mocks.readScratchAvailableCommands.mockResolvedValue([
    { name: "$aif-plan", description: "Plan", hint: "<x>" },
  ]);
});

describe("GET /api/scratch-runs/[runId]/commands (FR-A2)", () => {
  it("returns the availableCommands snapshot for a scratch run (viewer gate)", async () => {
    const res = await GET(req(), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      commands: [{ name: "$aif-plan", description: "Plan", hint: "<x>" }],
    });
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "proj-1",
      "readScratchRun",
    );
  });

  it("409 when the run does not exist", async () => {
    state.run = null;

    expect((await GET(req(), ctx)).status).toBe(409);
    expect(mocks.readScratchAvailableCommands).not.toHaveBeenCalled();
  });

  it("409 when the run is not a scratch run", async () => {
    state.run = { projectId: "proj-1", runKind: "flow" };

    expect((await GET(req(), ctx)).status).toBe(409);
  });

  it("403 when project access is denied", async () => {
    mocks.requireProjectAction.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "no access"),
    );

    expect((await GET(req(), ctx)).status).toBe(403);
  });
});
