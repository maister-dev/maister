// Task 13 (TDD, ADR-072 D5): server-side data source for the review-gate
// panel — `lib/review-comments/run-diff-source.ts`.
//
//   - `computeRunDiff` is EXTRACTED here from the collection route (the
//     run-detail layout is its third consumer); its behavior stays pinned by
//     the 32 route tests, exercised through GET/POST with the same mocks.
//   - `placementOf` (also extracted) is a TOTAL mapping: a missing prepared
//     diff or a defective root (null anchor fields) degrades to "outdated",
//     never a crash.
//   - `summarizeReviewThreads` is pure: openCount = OPEN roots only;
//     outdatedCount = open roots whose placement is "outdated". Resolved
//     threads never count, replies never count.
//   - `getReviewGateThreadCounts` is the layout glue: exactly ONE listThreads
//     query + AT MOST one diff computation per call — and the diff is SKIPPED
//     entirely when there are no open roots (gate-panel perf rule). A diff
//     failure (GC'd worktree, git error) degrades every open root to
//     "outdated" instead of throwing.
//
// The diff fixture goes through the REAL `prepareDiff` parse path (house rule
// from anchor.test.ts / the route tests: mock the git source, never the
// parser).

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ReviewComment } from "@/lib/review-comments/service";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { prepareDiff } from "@/lib/diff/prepare";
import {
  diffRunWorkspace,
  diffWorkingTree,
  resolveBaseRef,
} from "@/lib/worktree";
import {
  computeReviewDiff,
  getReviewGateThreadCounts,
  placementOf,
  summarizeReviewThreads,
} from "@/lib/review-comments/run-diff-source";
import { listThreads } from "@/lib/review-comments/service";

// ---------------------------------------------------------------------------
// Boundary mocks. The module imports `listThreads` (service) and the worktree
// git wrappers; mocking the service module also cuts its heavy import graph
// (services/hitl → authz/supervisor/runner — see service.test.ts).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const dbState: { workspaces: Row[]; projects: Row[] } = {
  workspaces: [],
  projects: [],
};

// Minimal drizzle-shaped fake: table identity is resolved through the real
// schema objects, mirroring the route tests' fake.
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => {
        const { workspaces, projects } = await import("@/lib/db/schema");

        if (table === workspaces) return dbState.workspaces;
        if (table === projects) return dbState.projects;
        throw new Error("unexpected table");
      },
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/worktree", () => ({
  diffRunWorkspace: vi.fn(),
  diffWorkingTree: vi.fn(),
  resolveBaseRef: vi.fn(),
}));
vi.mock("@/lib/review-comments/service", () => ({
  listThreads: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Real `git diff` stdout always terminates with a newline (prepareDiff trims).
const withFinalNewline = (lines: string[]): string => `${lines.join("\n")}\n`;

// src/calc.ts hunk line map:
//   ctx "const keep = 1;"    old 10 / new 10
//   del "const removed = 2;" old 11
//   add "const added = 2;"   new 11
//   ctx "const tail = 3;"    old 12 / new 12
const FIXTURE_DIFF = withFinalNewline([
  "diff --git a/src/calc.ts b/src/calc.ts",
  "index 1111111..2222222 100644",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -10,3 +10,3 @@",
  " const keep = 1;",
  "-const removed = 2;",
  "+const added = 2;",
  " const tail = 3;",
]);

const UNTRACKED_DIFF = withFinalNewline([
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# Draft",
  "+body",
]);

let seq = 0;

function rootRow(over: Partial<ReviewComment> = {}): ReviewComment {
  seq += 1;

  return {
    id: `c-${seq}`,
    runId: "run-1",
    hitlRequestId: "hitl-1",
    nodeId: "review",
    gateAttempt: 1,
    parentId: null,
    authorUserId: "u-1",
    authorLabel: "Reviewer",
    filePath: "src/calc.ts",
    side: "new",
    line: 11,
    lineContent: "const added = 2;",
    body: "comment body",
    status: "open",
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date(0),
    updatedAt: null,
    ...over,
  };
}

function thread(
  root: ReviewComment,
  replies: ReviewComment[] = [],
): { root: ReviewComment; replies: ReviewComment[] } {
  return { root, replies };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.workspaces = [
    {
      id: "ws-1",
      runId: "run-1",
      branch: "maister/feature",
      worktreePath: "/tmp/wt",
      baseCommit: "abc123",
      removedAt: null,
    },
  ];
  dbState.projects = [{ id: "p-1", mainBranch: "main" }];
  vi.mocked(diffWorkingTree).mockResolvedValue({
    text: UNTRACKED_DIFF,
    truncated: false,
    nameStatus: [{ path: "docs/new.md", status: "A" }],
  });
});

// ---------------------------------------------------------------------------
// computeReviewDiff — scoped diff source for inline review comments
// ---------------------------------------------------------------------------

describe("computeReviewDiff", () => {
  it("uses the working-tree diff for uncommitted review anchors", async () => {
    const prepared = await computeReviewDiff(
      fakeDb as unknown as NodePgDatabase,
      { id: "run-1", projectId: "p-1" },
      "uncommitted",
    );

    expect(
      placementOf(
        prepared,
        rootRow({
          filePath: "docs/new.md",
          line: 1,
          lineContent: "# Draft",
        }),
      ),
    ).toBe("inline");
    expect(diffWorkingTree).toHaveBeenCalledWith("/tmp/wt");
    expect(diffRunWorkspace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// placementOf — total mapping over (prepared | null, root)
// ---------------------------------------------------------------------------

describe("placementOf", () => {
  it("returns inline when the stored content matches the current diff at the anchor", async () => {
    const prepared = await prepareDiff(FIXTURE_DIFF, false);

    expect(placementOf(prepared, rootRow())).toBe("inline");
  });

  it("returns outdated when the content at the anchor differs", async () => {
    const prepared = await prepareDiff(FIXTURE_DIFF, false);

    expect(
      placementOf(prepared, rootRow({ lineContent: "const added = 99;" })),
    ).toBe("outdated");
  });

  it("returns outdated when no prepared diff is available", () => {
    expect(placementOf(null, rootRow())).toBe("outdated");
  });

  it("returns outdated for a defective root with null anchor fields", async () => {
    const prepared = await prepareDiff(FIXTURE_DIFF, false);

    expect(
      placementOf(
        prepared,
        rootRow({ filePath: null, side: null, line: null, lineContent: null }),
      ),
    ).toBe("outdated");
  });
});

// ---------------------------------------------------------------------------
// summarizeReviewThreads — pure count assembly
// ---------------------------------------------------------------------------

describe("summarizeReviewThreads", () => {
  it("counts open roots and the open-and-outdated subset", async () => {
    const prepared = await prepareDiff(FIXTURE_DIFF, false);
    const threads = [
      // open + inline → openCount only
      thread(rootRow()),
      // open + outdated (content drifted) → both counts
      thread(rootRow({ lineContent: "const added = 99;" })),
      // resolved + outdated → counts NOWHERE
      thread(
        rootRow({
          status: "resolved",
          lineContent: "gone",
          resolvedByUserId: "u-2",
          resolvedAt: new Date(0),
        }),
      ),
    ];

    expect(summarizeReviewThreads(threads, prepared)).toEqual({
      openCount: 2,
      outdatedCount: 1,
    });
  });

  it("treats every open root as outdated when the diff is unavailable", () => {
    const threads = [thread(rootRow()), thread(rootRow())];

    expect(summarizeReviewThreads(threads, null)).toEqual({
      openCount: 2,
      outdatedCount: 2,
    });
  });

  it("returns zeros for no threads", async () => {
    const prepared = await prepareDiff(FIXTURE_DIFF, false);

    expect(summarizeReviewThreads([], prepared)).toEqual({
      openCount: 0,
      outdatedCount: 0,
    });
  });

  it("ignores replies — only the root's status and placement count", async () => {
    const prepared = await prepareDiff(FIXTURE_DIFF, false);
    const reply = rootRow({
      parentId: "c-root",
      filePath: null,
      side: null,
      line: null,
      lineContent: null,
    });
    const threads = [thread(rootRow({ id: "c-root" }), [reply, reply])];

    expect(summarizeReviewThreads(threads, prepared)).toEqual({
      openCount: 1,
      outdatedCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// getReviewGateThreadCounts — layout glue (one query + at most one diff prep)
// ---------------------------------------------------------------------------

describe("getReviewGateThreadCounts", () => {
  it("skips the diff computation entirely when there are no open roots", async () => {
    vi.mocked(listThreads).mockResolvedValue([
      thread(rootRow({ status: "resolved" })),
    ]);

    const counts = await getReviewGateThreadCounts("run-1", "p-1");

    expect(counts).toEqual({ openCount: 0, outdatedCount: 0 });
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(diffRunWorkspace).not.toHaveBeenCalled();
    expect(resolveBaseRef).not.toHaveBeenCalled();
  });

  it("computes placement-aware counts with exactly one diff computation", async () => {
    vi.mocked(listThreads).mockResolvedValue([
      thread(rootRow()),
      thread(rootRow({ lineContent: "const added = 99;" })),
    ]);
    vi.mocked(diffRunWorkspace).mockResolvedValue({
      text: FIXTURE_DIFF,
      truncated: false,
    });

    const counts = await getReviewGateThreadCounts("run-1", "p-1");

    expect(counts).toEqual({ openCount: 2, outdatedCount: 1 });
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(diffRunWorkspace).toHaveBeenCalledTimes(1);
    // baseCommit is recorded on the workspace row → no merge-base resolution.
    expect(resolveBaseRef).not.toHaveBeenCalled();
  });

  it("degrades every open root to outdated when the diff source fails", async () => {
    vi.mocked(listThreads).mockResolvedValue([
      thread(rootRow()),
      thread(rootRow()),
    ]);
    vi.mocked(diffRunWorkspace).mockRejectedValue(new Error("worktree gone"));

    const counts = await getReviewGateThreadCounts("run-1", "p-1");

    expect(counts).toEqual({ openCount: 2, outdatedCount: 2 });
  });
});
