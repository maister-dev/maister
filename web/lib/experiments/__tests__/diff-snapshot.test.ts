import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  capExperimentDiffSnapshot,
  captureExperimentDiffSnapshotForRun,
  summarizeDiffFilesWithPatchHashes,
} from "@/lib/experiments/diff-snapshot";

const worktreeMocks = vi.hoisted(() => ({
  diffRunWorkspace: vi.fn(),
  diffRunWorkspaceFileMetadata: vi.fn(),
}));

vi.mock("@/lib/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/worktree")>()),
  diffRunWorkspace: worktreeMocks.diffRunWorkspace,
  diffRunWorkspaceFileMetadata: worktreeMocks.diffRunWorkspaceFileMetadata,
}));

type Row = Record<string, unknown>;

type CaptureState = {
  experimentRuns: Row[];
  projects: Row[];
  workspaces: Row[];
  updates: Row[];
};

function rowsFor(table: unknown, state: CaptureState): Row[] {
  switch (getTableName(table as never)) {
    case "experiment_runs":
      return state.experimentRuns;
    case "projects":
      return state.projects;
    case "workspaces":
      return state.workspaces;
    default:
      return [];
  }
}

function selectChain(rows: Row[]): PromiseLike<Row[]> & {
  where: () => ReturnType<typeof selectChain>;
} {
  return {
    then: (onFulfilled) => Promise.resolve(rows).then(onFulfilled),
    where: () => selectChain(rows),
  };
}

function fakeDb(state: CaptureState) {
  return {
    select: () => ({
      from: (table: unknown) => selectChain(rowsFor(table, state)),
    }),
    update: () => ({
      set: (patch: Row) => ({
        where: async () => {
          state.updates.push(patch);
        },
      }),
    }),
  };
}

describe("experiment diff snapshots", () => {
  it("summarizes every file from the full diff with stable patch hashes", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+created",
      "",
    ].join("\n");

    const summaries = summarizeDiffFilesWithPatchHashes(diff);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      path: "a.txt",
      status: "M",
      additions: 1,
      deletions: 1,
    });
    expect(summaries[1]).toMatchObject({
      path: "b.txt",
      status: "A",
      additions: 1,
      deletions: 0,
    });
    expect(summaries[0].patchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summaries[0].patchHash).not.toBe(summaries[1].patchHash);
  });

  it("caps snapshot text without dropping the full files summary signal", () => {
    const capped = capExperimentDiffSnapshot("abcdef", {
      maxBytes: 3,
      alreadyTruncated: false,
    });

    expect(capped).toEqual({
      text: "abc",
      bytes: 6,
      truncated: true,
    });
  });

  it("preserves upstream truncation even when text is below the experiment cap", () => {
    expect(
      capExperimentDiffSnapshot("abc", {
        maxBytes: 10,
        alreadyTruncated: true,
      }),
    ).toEqual({
      text: "abc",
      bytes: 3,
      truncated: true,
    });
  });

  it("stores complete file summaries from diff metadata when snapshot text is truncated upstream", async () => {
    worktreeMocks.diffRunWorkspace.mockResolvedValueOnce({
      text: [
        "diff --git a/a.ts b/a.ts",
        "index 111..222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      truncated: true,
    });
    worktreeMocks.diffRunWorkspaceFileMetadata.mockResolvedValueOnce([
      {
        path: "a.ts",
        status: "M",
        additions: 1,
        deletions: 1,
        oldOid: "111",
        newOid: "222",
      },
      {
        path: "b.ts",
        status: "A",
        additions: 3,
        deletions: 0,
        oldOid: "0".repeat(40),
        newOid: "333",
      },
    ]);
    const state: CaptureState = {
      experimentRuns: [
        {
          runId: "run-1",
          experimentId: "exp-1",
          baseCommit: "a".repeat(40),
          diffSnapshotCapturedAt: null,
        },
      ],
      workspaces: [
        {
          runId: "run-1",
          projectId: "project-1",
          branch: "exp/run-1",
          removedAt: null,
        },
      ],
      projects: [{ id: "project-1", repoPath: "/repo" }],
      updates: [],
    };

    const result = await captureExperimentDiffSnapshotForRun({
      db: fakeDb(state),
      runId: "run-1",
    });

    expect(result).toMatchObject({ status: "captured", fileCount: 2 });
    expect(state.updates[0].diffSnapshotTruncated).toBe(true);
    expect(state.updates[0].diffFilesSummary).toMatchObject([
      { path: "a.ts", status: "M", additions: 1, deletions: 1 },
      { path: "b.ts", status: "A", additions: 3, deletions: 0 },
    ]);
  });

  it("captures the diff with patch-derived file summaries when metadata lookup fails", async () => {
    const diffText = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    worktreeMocks.diffRunWorkspace.mockResolvedValueOnce({
      text: diffText,
      truncated: false,
    });
    worktreeMocks.diffRunWorkspaceFileMetadata.mockRejectedValueOnce(
      new Error("metadata buffer exceeded"),
    );
    const state: CaptureState = {
      experimentRuns: [
        {
          runId: "run-1",
          experimentId: "exp-1",
          baseCommit: "a".repeat(40),
          diffSnapshotCapturedAt: null,
        },
      ],
      workspaces: [
        {
          runId: "run-1",
          projectId: "project-1",
          branch: "exp/run-1",
          removedAt: null,
        },
      ],
      projects: [{ id: "project-1", repoPath: "/repo" }],
      updates: [],
    };

    const result = await captureExperimentDiffSnapshotForRun({
      db: fakeDb(state),
      runId: "run-1",
    });

    expect(result).toMatchObject({ status: "captured", fileCount: 1 });
    expect(state.updates[0]).toMatchObject({
      diffSnapshot: diffText,
      diffSnapshotTruncated: false,
    });
    expect(state.updates[0].diffFilesSummary).toMatchObject([
      { path: "a.ts", status: "M", additions: 1, deletions: 1 },
    ]);
  });
});
