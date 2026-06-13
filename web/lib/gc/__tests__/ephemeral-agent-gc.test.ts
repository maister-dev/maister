import { beforeEach, describe, expect, it, vi } from "vitest";

const readdirMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({ readdir: readdirMock }));
vi.mock("@/lib/instance-config", () => ({
  worktreesRoot: () => "/tmp/wt-root",
}));

import { runEphemeralAgentGcSweep } from "../ephemeral-agent-gc";

// Minimal thenable query-builder: the projects select is awaited with no
// `.where()` (resolves projectRows); the runs select calls `.where()`
// (resolves the live-run rows).
function fakeDb(projectRows: unknown[], liveRunRows: unknown[]) {
  return {
    select() {
      return {
        from() {
          return {
            where: () => Promise.resolve(liveRunRows),
            then: (
              onF: (v: unknown) => unknown,
              onR: (e: unknown) => unknown,
            ) => Promise.resolve(projectRows).then(onF, onR),
          };
        },
      };
    },
  } as unknown as NonNullable<
    Parameters<typeof runEphemeralAgentGcSweep>[0]
  >["db"];
}

describe("runEphemeralAgentGcSweep", () => {
  beforeEach(() => {
    readdirMock.mockReset();
  });

  it("reaps -ro dirs whose run is terminal or absent, keeps live ones, ignores non-ro dirs", async () => {
    // live1: still Running -> keep. dead1: terminal -> reap. absent1: no run
    // row -> reap. The two non-`-ro` entries must be ignored entirely.
    readdirMock.mockResolvedValue([
      "live1-ro",
      "dead1-ro",
      "absent1-ro",
      "regular-worktree",
      "scratch-xyz",
    ]);
    const remove = vi.fn().mockResolvedValue(undefined);

    const summary = await runEphemeralAgentGcSweep({
      db: fakeDb(
        [{ slug: "proj", repoPath: "/repos/proj" }],
        [{ id: "live1" }],
      ),
      removeOwnedWorktree: remove,
    });

    expect(summary).toEqual({ scanned: 3, removed: 2, live: 1, failed: 0 });

    const removedPaths = remove.mock.calls.map((c) => c[0].worktreePath).sort();

    expect(removedPaths).toEqual([
      "/tmp/wt-root/proj/absent1-ro",
      "/tmp/wt-root/proj/dead1-ro",
    ]);
    // The live run's checkout is never touched.
    expect(removedPaths).not.toContain("/tmp/wt-root/proj/live1-ro");
    // Every removal is path-guarded to the worktrees root.
    for (const call of remove.mock.calls) {
      expect(call[0].allowedRoot).toBe("/tmp/wt-root");
      expect(call[0].force).toBe(true);
      expect(call[0].projectRepoPath).toBe("/repos/proj");
    }
  });

  it("counts a removal failure and continues (left for retry)", async () => {
    readdirMock.mockResolvedValue(["dead1-ro", "dead2-ro"]);
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("git locked"))
      .mockResolvedValueOnce(undefined);

    const summary = await runEphemeralAgentGcSweep({
      db: fakeDb([{ slug: "proj", repoPath: "/repos/proj" }], []),
      removeOwnedWorktree: remove,
    });

    expect(summary).toEqual({ scanned: 2, removed: 1, live: 0, failed: 1 });
  });

  it("skips a project whose worktree subtree does not exist", async () => {
    readdirMock.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const remove = vi.fn();

    const summary = await runEphemeralAgentGcSweep({
      db: fakeDb([{ slug: "proj", repoPath: "/repos/proj" }], []),
      removeOwnedWorktree: remove,
    });

    expect(summary).toEqual({ scanned: 0, removed: 0, live: 0, failed: 0 });
    expect(remove).not.toHaveBeenCalled();
  });
});
