import { describe, expect, it, vi } from "vitest";

import { transitionExperimentStatus } from "@/lib/experiments/repository";

function fakeTx() {
  const where = vi.fn(async () => []);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));

  return { tx: { update }, update, set, where };
}

describe("experiment repository", () => {
  it("updates status with the matching terminal timestamp inside the provided tx", async () => {
    const now = new Date("2026-07-03T10:00:00.000Z");
    const { tx, update, set, where } = fakeTx();

    await transitionExperimentStatus(tx, {
      experimentId: "exp-1",
      fromStatus: "comparable",
      toStatus: "concluded",
      now,
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      status: "concluded",
      updatedAt: now,
      concludedAt: now,
    });
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("rejects forbidden transitions before issuing an update", async () => {
    const { tx, update } = fakeTx();

    await expect(
      transitionExperimentStatus(tx, {
        experimentId: "exp-1",
        fromStatus: "running",
        toStatus: "concluded",
        now: new Date("2026-07-03T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(update).not.toHaveBeenCalled();
  });
});
