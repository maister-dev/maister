import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import { LEGACY_STEPS_REFUSAL_MESSAGE } from "@/lib/flows/manifest-shape";

const mocks = vi.hoisted(() => ({
  installRevision: vi.fn(),
}));

vi.mock("@/lib/flows", () => ({
  ensureSymlink: vi.fn(),
  installRevision: mocks.installRevision,
  runRevisionSetup: vi.fn(),
}));

const updates: Record<string, unknown>[] = [];
const FLOW = {
  id: "flow-row-1",
  projectId: "project-1",
  flowRefId: "aif",
  source: "file:///tmp/aif",
  enabledRevisionId: "enabled-revision",
  enablementState: "Enabled",
  trustStatus: "trusted",
};

const db = {
  select: () => ({
    from: () => ({ where: async () => [FLOW] }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        updates.push(values);
      },
    }),
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  updates.splice(0);
  mocks.installRevision.mockResolvedValue({ revisionId: "candidate-revision" });
});

describe("upgradeFlow graph-only manifest boundary", () => {
  it("uses CONFIG validation for an upgrade and never repoints enablement", async () => {
    const { upgradeFlow } = await import("@/lib/flows/lifecycle");

    await expect(
      upgradeFlow({
        db,
        flowRefId: "aif",
        projectId: "project-1",
        source: "file:///tmp/aif",
        version: "v2",
      }),
    ).resolves.toEqual({ revisionId: "candidate-revision" });

    expect(mocks.installRevision).toHaveBeenCalledWith(
      expect.objectContaining({ manifestErrorCode: "CONFIG" }),
    );
    expect(updates).toEqual([
      expect.objectContaining({ enablementState: "UpdateAvailable" }),
    ]);
    expect(updates[0]).not.toHaveProperty("enabledRevisionId");
  });

  it("propagates the locked legacy refusal without changing pointers", async () => {
    mocks.installRevision.mockRejectedValueOnce(
      new MaisterError("CONFIG", LEGACY_STEPS_REFUSAL_MESSAGE),
    );
    const { upgradeFlow } = await import("@/lib/flows/lifecycle");

    await expect(
      upgradeFlow({
        db,
        flowRefId: "aif",
        projectId: "project-1",
        source: "file:///tmp/aif",
        version: "v2",
      }),
    ).rejects.toMatchObject({
      code: "CONFIG",
      message: LEGACY_STEPS_REFUSAL_MESSAGE,
    });
    expect(updates).toEqual([]);
  });
});
