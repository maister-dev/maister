// M22 Phase 5 (T5.4) → ADR-066 Phase 2 (T2.8) migration: render tests for the
// PRESENTATIONAL changed-files list of the workbench diff surface.
//
// We render ONLY the named, presentational export `ChangedFilesList` — it takes
// a seeded `DiffFileEntry[]` and has NO fetching and NO effects. The fetching
// container `RunDiff({ runId, labels })` lazily fetches `GET /api/runs/${runId}/diff`
// and (post-ADR-066) renders <DiffView/> (git-diff-view) + the changed-files
// list; under renderToStaticMarkup effects DO NOT run, so the container is NOT
// the render-test target here (its fetch + diff-view are the e2e's job).
//
// ADR-066 migration notes:
//   - The raw-diff `<pre>` is GONE; per-file split now lives in
//     `lib/diff/prepare.ts` (`prepareDiff`), so the old `extractFileSection`
//     describe block RELOCATES to `lib/diff/__tests__/prepare.test.ts`
//     ("splits the two files apart") and is removed here.
//   - The changed-files list gains per-file `+`/`−` count badges; we add a
//     resilient assertion that the counts render alongside the existing
//     data-status / path assertions.
//
// Mirrors components/workbench/__tests__/file-tree.test.ts (createElement +
// renderToStaticMarkup, no jsdom). `.test.ts` to match the unit glob
// (`components/**/__tests__/**/*.test.ts`).
//
// ADR-072 (Task 12) extends this file with the review wiring of the
// container: an optional `review` server-context prop, a threads fetch
// alongside the diff fetch, and the mutation→refetch→router.refresh loop.
// renderToStaticMarkup cannot run effects, so the async wiring is tested
// through the SMALL exported helpers (`loadReviewThreads`,
// `reviewMutationRequest`, `executeReviewMutation`, `buildDiffViewReview`,
// `ReviewActionAlert`) with a stubbed global fetch — the container glue stays
// a thin composition of exactly these helpers.

import type {
  ReviewCommentDto,
  ReviewThread,
} from "@/components/workbench/diff-view";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/runs/run-1",
  useSearchParams: () => new URLSearchParams(),
}));

import RunDiff, {
  buildDiffViewReview,
  ChangedFilesList,
  diffScopeOrDefault,
  executeReviewMutation,
  loadReviewThreads,
  reviewEnabledForScope,
  ReviewActionAlert,
  reviewMutationRequest,
  type ReviewMutation,
  type RunDiffLabels,
  type RunDiffReviewContext,
} from "@/components/workbench/run-diff";

// The changed-files entry gains `additions`/`deletions` for the per-file `+`/`−`
// badges (server-computed in prepareDiff; ADR-066 T2.3/T2.5).
type DiffFileEntry = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
};

const LABELS = { empty: "workbench.diff.empty" };

// Distinctive double-digit counts chosen to avoid colliding with the digits in
// the component's Tailwind class strings (e.g. `text-[11px]`, `w-3`), so the
// badge assertion can only pass when the counts are actually rendered.
const SEED: DiffFileEntry[] = [
  { path: "src/a.ts", status: "M", additions: 42, deletions: 17 },
  { path: "b.ts", status: "A", additions: 88, deletions: 0 },
];

function render(files: DiffFileEntry[]): string {
  return renderToStaticMarkup(
    createElement(ChangedFilesList, { files, labels: LABELS }),
  );
}

describe("ChangedFilesList — seeded changed-files rendering (M22 T5.4 → ADR-066)", () => {
  const html = render(SEED);

  it("renders one item per changed file", () => {
    const count = html.split('data-testid="changed-file"').length - 1;

    expect(count).toBe(SEED.length);
  });

  it("renders each file's path text", () => {
    for (const file of SEED) {
      expect(html).toContain(file.path);
    }
  });

  it("renders the modify entry with data-status='M'", () => {
    expect(html).toContain('data-status="M"');
  });

  it("renders the add entry with data-status='A'", () => {
    expect(html).toContain('data-status="A"');
  });

  it("renders the per-file +/− count badges (ADR-066)", () => {
    // The list shows server-computed additions/deletions per file. Assert the
    // distinctive counts appear (resilient to the badge's exact markup / `+`/`−`
    // glyph choice — we check the numeric counts render, not a fixed testid).
    expect(html).toContain("42"); // src/a.ts additions
    expect(html).toContain("17"); // src/a.ts deletions
    expect(html).toContain("88"); // b.ts additions
  });

  it("renders the empty-state label for an empty files list", () => {
    const empty = render([]);

    expect(empty).toContain("workbench.diff.empty");
    expect(empty).not.toContain('data-testid="changed-file"');
  });
});

// ---------------------------------------------------------------------------
// ADR-072 review wiring (Task 12)
// ---------------------------------------------------------------------------

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

const RUN_DIFF_LABELS: RunDiffLabels = {
  title: "workbench.diff.title",
  empty: "workbench.diff.empty",
  error: "workbench.diff.error",
  changedFiles: "workbench.diff.changedFiles",
  bodyUnavailable: "workbench.diff.bodyUnavailable",
  added: "L.added",
  removed: "L.removed",
  displayMode: "L.displayMode",
  rich: "L.rich",
  raw: "L.raw",
  showFiles: "L.showFiles",
  hideFiles: "L.hideFiles",
  refresh: "L.refresh",
  viewMode: "L.viewMode",
  split: "L.split",
  unified: "L.unified",
  truncated: "L.truncated",
};

const REVIEW_LABELS: RunDiffReviewContext["labels"] = {
  composerPlaceholder: "review.composerPlaceholder",
  composerSubmit: "review.submit",
  composerCancel: "review.cancel",
  reply: "review.reply",
  edit: "review.edit",
  delete: "review.delete",
  resolve: "review.resolve",
  unresolve: "review.unresolve",
  resolved: "review.resolved",
  iteration: "Iteration $n",
  expand: "review.expand",
  collapse: "review.collapse",
  outdatedTitle: "review.outdatedTitle",
  sideOld: "review.sideOld",
  sideNew: "review.sideNew",
  error: "review.error",
};

function reviewContext(
  over: Partial<RunDiffReviewContext> = {},
): RunDiffReviewContext {
  return {
    currentUserId: "user-a",
    canComment: true,
    labels: REVIEW_LABELS,
    ...over,
  };
}

function comment(id: string): ReviewCommentDto {
  return {
    id,
    runId: "run-1",
    hitlRequestId: "hitl-1",
    nodeId: "review",
    gateAttempt: 1,
    parentId: null,
    authorUserId: "user-a",
    authorLabel: "Alice Reviewer",
    filePath: "src/a.ts",
    side: "new",
    line: 14,
    lineContent: "const x = 1;",
    body: "Anchored remark.",
    status: "open",
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: "2026-06-10T10:00:00.000Z",
    updatedAt: null,
  };
}

function thread(id: string): ReviewThread {
  return { root: comment(id), placement: "inline", replies: [] };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeEffects(): {
  setBusy: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
  setThreads: ReturnType<typeof vi.fn<(threads: ReviewThread[]) => void>>;
  setError: ReturnType<typeof vi.fn<(message: string | null) => void>>;
  refresh: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    setBusy: vi.fn<(busy: boolean) => void>(),
    setThreads: vi.fn<(threads: ReviewThread[]) => void>(),
    setError: vi.fn<(message: string | null) => void>(),
    refresh: vi.fn<() => void>(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RunDiff — optional review prop (ADR-072)", () => {
  it("renders identical pre-data markup with and without the review prop", () => {
    const without = renderToStaticMarkup(
      createElement(RunDiff, { runId: "run-1", labels: RUN_DIFF_LABELS }),
    );
    const withReview = renderToStaticMarkup(
      createElement(RunDiff, {
        runId: "run-1",
        labels: RUN_DIFF_LABELS,
        review: reviewContext(),
      }),
    );

    expect(without).toContain('data-testid="run-diff-loading"');
    expect(withReview).toBe(without);
  });
});

describe("diffScopeOrDefault", () => {
  it("accepts the uncommitted deep-link scope", () => {
    expect(diffScopeOrDefault("uncommitted")).toBe("uncommitted");
  });

  it("falls back to the run scope for invalid input", () => {
    expect(diffScopeOrDefault("unknown")).toBe("run");
  });
});

describe("reviewEnabledForScope", () => {
  it("enables inline review only on the canonical run diff", () => {
    expect(reviewEnabledForScope(reviewContext(), "run")).toBe(true);
    expect(reviewEnabledForScope(reviewContext(), "uncommitted")).toBe(false);
    expect(reviewEnabledForScope(reviewContext(), "since-last-review")).toBe(
      false,
    );
    expect(reviewEnabledForScope(undefined, "run")).toBe(false);
  });
});

describe("loadReviewThreads — threads-effect body", () => {
  it("issues NO request when review mode is off", async () => {
    const fetchMock = vi.fn<FetchLike>();

    vi.stubGlobal("fetch", fetchMock);

    const apply = vi.fn();

    await loadReviewThreads("run-1", false, apply);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("GETs the review-comments collection and applies the threads", async () => {
    const threads = [thread("c-1")];
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ threads }));

    vi.stubGlobal("fetch", fetchMock);

    const apply = vi.fn();

    await loadReviewThreads("run-1", true, apply);

    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1/review-comments");
    expect(apply).toHaveBeenCalledWith({ threads });
  });

  it("applies the server's error message when the GET fails (degraded mode)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { code: "UNAUTHORIZED", message: "forbidden" },
        { status: 403 },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const apply = vi.fn();

    await loadReviewThreads("run-1", true, apply);

    expect(apply).toHaveBeenCalledWith({ error: "forbidden" });
  });

  it("falls back to the HTTP status when the error body is not JSON", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => new Response("boom", { status: 502 }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const apply = vi.fn();

    await loadReviewThreads("run-1", true, apply);

    expect(apply).toHaveBeenCalledWith({ error: "HTTP 502" });
  });
});

describe("reviewMutationRequest — ADR-072 route family mapping", () => {
  it("maps createRoot to POST collection with the flattened anchor", () => {
    const { url, init } = reviewMutationRequest("run-1", {
      kind: "createRoot",
      anchor: { filePath: "src/a.ts", side: "new", line: 14 },
      body: "Anchored remark.",
    });

    expect(url).toBe("/api/runs/run-1/review-comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      filePath: "src/a.ts",
      side: "new",
      line: 14,
      body: "Anchored remark.",
    });
  });

  it("maps reply to POST collection with {parentId, body}", () => {
    const { url, init } = reviewMutationRequest("run-1", {
      kind: "reply",
      parentId: "c-root",
      body: "A reply.",
    });

    expect(url).toBe("/api/runs/run-1/review-comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      parentId: "c-root",
      body: "A reply.",
    });
  });

  it("maps edit to PATCH item with {body}", () => {
    const { url, init } = reviewMutationRequest("run-1", {
      kind: "edit",
      commentId: "c-9",
      body: "Edited.",
    });

    expect(url).toBe("/api/runs/run-1/review-comments/c-9");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ body: "Edited." });
  });

  it("maps setStatus to PATCH item with {status}", () => {
    const { url, init } = reviewMutationRequest("run-1", {
      kind: "setStatus",
      commentId: "c-9",
      status: "resolved",
    });

    expect(url).toBe("/api/runs/run-1/review-comments/c-9");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ status: "resolved" });
  });

  it("maps delete to DELETE item with no body", () => {
    const { url, init } = reviewMutationRequest("run-1", {
      kind: "delete",
      commentId: "c-9",
    });

    expect(url).toBe("/api/runs/run-1/review-comments/c-9");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});

describe("executeReviewMutation — refetch + refresh on success, reject on failure (ADR-072 D8)", () => {
  const MUTATION: ReviewMutation = {
    kind: "reply",
    parentId: "c-root",
    body: "A reply.",
  };

  it("on success: writes, refetches threads once, clears the alert, refreshes the router", async () => {
    const refetched = [thread("c-root")];
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });

      return calls.length === 1
        ? jsonResponse({ comment: comment("c-new") }, { status: 201 })
        : jsonResponse({ threads: refetched });
    });

    vi.stubGlobal("fetch", fetchMock);

    const effects = makeEffects();

    await executeReviewMutation("run-1", MUTATION, effects);

    expect(calls).toEqual([
      { url: "/api/runs/run-1/review-comments", method: "POST" },
      { url: "/api/runs/run-1/review-comments", method: "GET" },
    ]);
    expect(effects.setThreads).toHaveBeenCalledWith(refetched);
    expect(effects.setError).toHaveBeenCalledWith(null);
    expect(effects.refresh).toHaveBeenCalledTimes(1);
  });

  it("holds busy for exactly the in-flight window", async () => {
    let busy = false;
    let busyDuringWrite: boolean | null = null;
    const fetchMock = vi.fn<FetchLike>(async (_input, init) => {
      if (init?.method === "PATCH") busyDuringWrite = busy;

      return jsonResponse({ threads: [] });
    });

    vi.stubGlobal("fetch", fetchMock);

    const effects = makeEffects();
    const busyCalls: boolean[] = [];

    effects.setBusy.mockImplementation((next: boolean) => {
      busy = next;
      busyCalls.push(next);
    });

    await executeReviewMutation(
      "run-1",
      { kind: "setStatus", commentId: "c-9", status: "resolved" },
      effects,
    );

    expect(busyDuringWrite).toBe(true);
    expect(busyCalls).toEqual([true, false]);
  });

  it("on failure: rejects (drafts survive), surfaces the server message, no refetch, no refresh", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { code: "PRECONDITION", message: "review gate is not open" },
        { status: 409 },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const effects = makeEffects();

    await expect(
      executeReviewMutation("run-1", MUTATION, effects),
    ).rejects.toThrow("review gate is not open");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(effects.setError).toHaveBeenCalledWith("review gate is not open");
    expect(effects.setThreads).not.toHaveBeenCalled();
    expect(effects.refresh).not.toHaveBeenCalled();
    expect(effects.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("resolves when the write lands but the refetch fails (no duplicate-submit re-arm)", async () => {
    const fetchMock = vi.fn<FetchLike>(async (_input, init) =>
      init?.method === "POST"
        ? jsonResponse({ comment: comment("c-new") }, { status: 201 })
        : jsonResponse(
            { code: "CRASH", message: "internal error" },
            { status: 500 },
          ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const effects = makeEffects();

    await executeReviewMutation("run-1", MUTATION, effects);

    expect(effects.setThreads).not.toHaveBeenCalled();
    expect(effects.setError).toHaveBeenCalledWith("internal error");
    expect(effects.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("buildDiffViewReview — DiffView review object assembly", () => {
  it("returns undefined when the server passed no review context", () => {
    const review = buildDiffViewReview({
      context: undefined,
      threads: [],
      busy: false,
      mutate: vi.fn<(mutation: ReviewMutation) => Promise<void>>(),
    });

    expect(review).toBeUndefined();
  });

  it("keeps root commenting available while existing threads are still loading", () => {
    const review = buildDiffViewReview({
      context: reviewContext(),
      threads: null,
      busy: false,
      mutate: vi.fn<(mutation: ReviewMutation) => Promise<void>>(),
    });

    expect(review).toBeDefined();
    expect(review?.threads).toEqual([]);
    expect(review?.canComment).toBe(true);
  });

  it("passes threads, identity, permission, busy and labels through", () => {
    const threads = [thread("c-1")];
    const review = buildDiffViewReview({
      context: reviewContext(),
      threads,
      busy: true,
      mutate: vi.fn<(mutation: ReviewMutation) => Promise<void>>(),
    });

    expect(review).toBeDefined();
    expect(review?.threads).toBe(threads);
    expect(review?.currentUserId).toBe("user-a");
    expect(review?.canComment).toBe(true);
    expect(review?.busy).toBe(true);
    expect(review?.labels).toBe(REVIEW_LABELS);
  });

  it("maps every callback onto its mutation", async () => {
    const mutate = vi.fn<(mutation: ReviewMutation) => Promise<void>>(
      async () => undefined,
    );
    const review = buildDiffViewReview({
      context: reviewContext(),
      threads: [],
      busy: false,
      mutate,
    });

    if (!review) throw new Error("review object expected");

    await review.onCreateRoot(
      { filePath: "src/a.ts", side: "old", line: 3 },
      "Root.",
    );
    await review.onReply("c-root", "Reply.");
    await review.onEdit("c-1", "Edited.");
    await review.onSetStatus("c-1", "resolved");
    await review.onDelete("c-1");

    expect(mutate.mock.calls.map(([mutation]) => mutation)).toEqual([
      {
        kind: "createRoot",
        anchor: { filePath: "src/a.ts", side: "old", line: 3 },
        body: "Root.",
      },
      { kind: "reply", parentId: "c-root", body: "Reply." },
      { kind: "edit", commentId: "c-1", body: "Edited." },
      { kind: "setStatus", commentId: "c-1", status: "resolved" },
      { kind: "delete", commentId: "c-1" },
    ]);
  });
});

describe("ReviewActionAlert — review error surface", () => {
  it("renders nothing while there is no error", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewActionAlert, {
        label: "review.error",
        message: null,
      }),
    );

    expect(html).toBe("");
  });

  it("renders the generic label plus the server message under role=alert", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewActionAlert, {
        label: "review.error",
        message: "review gate is not open",
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("review.error: review gate is not open");
  });
});
