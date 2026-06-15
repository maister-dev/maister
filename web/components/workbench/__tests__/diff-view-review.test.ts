// ADR-072 review-mode wiring of the diff renderer:
//   1. review-off renders BYTE-IDENTICAL markup to the pre-review component
//      (pinned against a captured fixture render), both with an empty diff
//      and with a fully RENDERED GitDiffView (real DiffFile bundle);
//   2. the Outdated section renders below the diff in review mode;
//   3. buildReviewExtendData maps inline threads of the ACTIVE file into the
//      native @git-diff-view/react extendData shape (oldFile/newFile keyed by
//      String(line));
//   4. anchorSideOf maps the lib SplitSide enum to the wire 'old' | 'new'.
//
// GitDiffView renders its diff rows statically from a full bundle, including
// lib-level extend rows (data-state="extend") for extendData-keyed lines —
// the extend-row CONTENT (our ReviewThreadStack) fills client-side only, so
// the render-prop BODIES are exported components tested in
// review-comment-composer.test.ts / review-thread-card.test.ts.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DiffFile, SplitSide } from "@git-diff-view/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/runs/r1",
  useSearchParams: () => new URLSearchParams(),
}));

import {
  anchorSideOf,
  buildReviewExtendData,
  DiffView,
  type DiffViewReview,
  type PreparedFile,
} from "@/components/workbench/diff-view";
import {
  type ReviewCommentDto,
  type ReviewCommentsLabels,
  type ReviewThread,
} from "@/components/workbench/review-thread-card";

const DIFF_LABELS = {
  empty: "L.empty",
  bodyUnavailable: "L.bodyUnavailable",
  added: "L.added",
  removed: "L.removed",
  viewMode: "L.viewMode",
  split: "L.split",
  unified: "L.unified",
  truncated: "L.truncated",
};

const REVIEW_LABELS: ReviewCommentsLabels = {
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
};

// Captured render of the PRE-review-mode component for this exact fixture
// (files list + empty perFile + mode "split", dark theme fallback). The
// review-off path must keep producing exactly this markup.
const CAPTURED_REVIEW_OFF_MARKUP =
  '<div class="flex flex-col gap-2" data-testid="diff-view-wrap"><div class="grid grid-cols-1 gap-3 md:grid-cols-[minmax(200px,280px)_1fr]" data-diff-mode="split" data-testid="diff-view"><div class="overflow-auto rounded-[10px] border border-line bg-paper p-1.5"><ul class="m-0 flex list-none flex-col gap-0.5 p-0"><li><button class="flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left font-mono text-[11px] text-ink-2 hover:bg-ivory aria-[current]:bg-ivory" data-status="M" data-testid="changed-file" type="button"><span class="w-3 shrink-0 text-center font-bold text-mute">M</span><span class="grow truncate">src/a.ts</span><span aria-label="L.added" class="shrink-0 font-semibold text-[#1a7f37] dark:text-[#3fb950]" data-testid="changed-file-additions">+4</span><span aria-label="L.removed" class="shrink-0 font-semibold text-[#cf222e] dark:text-[#f85149]" data-testid="changed-file-deletions">−2</span></button></li></ul></div><div class="min-w-0 overflow-auto rounded-[10px] border border-line bg-paper"><div aria-label="L.viewMode" class="flex justify-end gap-1 border-b border-line p-1.5" role="group"><button aria-pressed="true" class="rounded-[6px] px-2 py-1 font-mono text-[11px] text-ink-2 hover:bg-ivory aria-[pressed=true]:bg-ivory aria-[pressed=true]:font-semibold" data-testid="diff-view-mode-split" type="button">L.split</button><button aria-pressed="false" class="rounded-[6px] px-2 py-1 font-mono text-[11px] text-ink-2 hover:bg-ivory aria-[pressed=true]:bg-ivory aria-[pressed=true]:font-semibold" data-testid="diff-view-mode-unified" type="button">L.unified</button></div><p class="p-4 text-center font-mono text-[11px] text-mute" data-testid="diff-view-empty">L.empty</p></div></div></div>';

// A real parseable section for `src/a.ts` (new side lines 1-2, old side
// lines 1-2) so GitDiffView renders actual rows. Mirrors how
// lib/diff/prepare.ts builds the full bundle, minus the Shiki initSyntax —
// plain text is enough for the structural pins here.
const DIFF_SECTION = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 0000001..0000002 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
  " const b = 3;",
  "",
].join("\n");

function makePreparedFile(): PreparedFile {
  const file = new DiffFile(
    "src/a.ts",
    "",
    "src/a.ts",
    "",
    [DIFF_SECTION],
    "ts",
    "ts",
  );

  file.initTheme("light");
  file.initRaw();
  file.buildSplitDiffLines();
  file.buildUnifiedDiffLines();

  return { path: "src/a.ts", fileLang: "ts", bundle: file._getFullBundle() };
}

function comment(over: Partial<ReviewCommentDto> = {}): ReviewCommentDto {
  return {
    id: "c-root-1",
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
    ...over,
  };
}

function inlineThread(over: Partial<ReviewCommentDto> = {}): ReviewThread {
  return { root: comment(over), placement: "inline", replies: [] };
}

function makeReview(over: Partial<DiffViewReview> = {}): DiffViewReview {
  return {
    threads: [],
    currentUserId: "user-a",
    canComment: true,
    onCreateRoot: vi.fn(),
    onReply: vi.fn(),
    onEdit: vi.fn(),
    onSetStatus: vi.fn(),
    onDelete: vi.fn(),
    labels: REVIEW_LABELS,
    ...over,
  };
}

type DiffViewProps = Parameters<typeof DiffView>[0];

function render(over: Partial<DiffViewProps> = {}): string {
  const base: DiffViewProps = {
    files: [{ path: "src/a.ts", status: "M", additions: 4, deletions: 2 }],
    perFile: [],
    labels: DIFF_LABELS,
    mode: "split",
  };

  return renderToStaticMarkup(createElement(DiffView, { ...base, ...over }));
}

describe("DiffView — review mode off (regression pin)", () => {
  it("renders byte-identical markup to the pre-review component", () => {
    expect(render()).toBe(CAPTURED_REVIEW_OFF_MARKUP);
  });

  it("renders no review surface without the review prop", () => {
    const html = render();

    expect(html).not.toContain("review-");
    expect(html).not.toContain("outdated");
  });

  it("renders the body-unavailable message when only file summary is available", () => {
    const html = render({ renderUnavailable: true });

    expect(html).toContain('data-testid="diff-view-body-unavailable"');
    expect(html).toContain("L.bodyUnavailable");
  });

  it("renders the same chrome when review mode is on but has no threads", () => {
    expect(render({ review: makeReview() })).toBe(CAPTURED_REVIEW_OFF_MARKUP);
  });
});

// The empty-perFile pin above cannot see review-prop bleed-through INSIDE the
// rendered diff. GitDiffView renders statically from a full bundle, so these
// pin at the real rendered-row level.
describe("DiffView — review-off pin with a RENDERED diff", () => {
  const renderedOff = render({ perFile: [makePreparedFile()] });

  it("sanity: the fixture renders actual diff content, not the empty state", () => {
    expect(renderedOff).toContain("const a");
    expect(renderedOff).not.toContain('data-testid="diff-view-empty"');
  });

  it("review on, zero threads, cannot comment ⇒ byte-identical rendered diff", () => {
    const html = render({
      perFile: [makePreparedFile()],
      review: makeReview({ canComment: false }),
    });

    expect(html).toBe(renderedOff);
  });

  it("review on, zero threads, can comment ⇒ add-widget affordance only, no extend rows", () => {
    const html = render({
      perFile: [makePreparedFile()],
      review: makeReview(),
    });

    // The composer click target is the ONE intended markup difference…
    expect(html).toContain("diff-add-widget");
    // …and nothing extendData-driven may appear with zero threads.
    expect(html).not.toContain('data-state="extend"');
    expect(html).not.toContain("diff-line-extend");
    expect(html).not.toContain('data-testid="outdated-threads"');
  });

  it("falsifiability control: an inline thread on the rendered file DOES emit extend rows", () => {
    const html = render({
      perFile: [makePreparedFile()],
      review: makeReview({
        threads: [inlineThread({ line: 1, lineContent: "const a = 2;" })],
      }),
    });

    expect(html).toContain('data-state="extend"');
    expect(html).toContain("diff-line-extend");
  });
});

describe("DiffView — review mode on (ADR-072)", () => {
  it("renders the collapsible Outdated section below the diff", () => {
    const html = render({
      review: makeReview({
        threads: [
          {
            root: comment({
              id: "c-out",
              filePath: "src/other.ts",
              side: "old",
              line: 3,
              lineContent: "stale line",
              body: "Outdated remark.",
            }),
            placement: "outdated",
            replies: [],
          },
        ],
      }),
    });

    expect(html).toContain('data-testid="outdated-threads"');
    expect(html).toContain("review.outdatedTitle");
    expect(html).toContain("src/other.ts:3");
    expect(html).toContain("stale line");
    expect(html).toContain("Outdated remark.");
  });

  it("does not render the Outdated section when every thread is inline", () => {
    const html = render({
      review: makeReview({ threads: [inlineThread()] }),
    });

    expect(html).not.toContain('data-testid="outdated-threads"');
  });
});

describe("buildReviewExtendData — inline threads of the active file", () => {
  it("keys inline threads by side and String(line)", () => {
    const oldThread = inlineThread({ id: "c-old", side: "old", line: 3 });
    const newThread = inlineThread({ id: "c-new", side: "new", line: 14 });
    const data = buildReviewExtendData([oldThread, newThread], "src/a.ts");

    expect(Object.keys(data.oldFile)).toEqual(["3"]);
    expect(Object.keys(data.newFile)).toEqual(["14"]);
    expect(data.oldFile["3"].data).toEqual([oldThread]);
    expect(data.newFile["14"].data).toEqual([newThread]);
  });

  it("stacks multiple threads anchored to the same line in order", () => {
    const first = inlineThread({ id: "c-1", line: 14 });
    const second = inlineThread({ id: "c-2", line: 14 });
    const data = buildReviewExtendData([first, second], "src/a.ts");

    expect(data.newFile["14"].data).toEqual([first, second]);
  });

  it("excludes outdated placements and other files", () => {
    const outdated: ReviewThread = {
      root: comment({ id: "c-out" }),
      placement: "outdated",
      replies: [],
    };
    const otherFile = inlineThread({
      id: "c-other",
      filePath: "src/other.ts",
    });
    const data = buildReviewExtendData([outdated, otherFile], "src/a.ts");

    expect(data.oldFile).toEqual({});
    expect(data.newFile).toEqual({});
  });

  it("returns empty maps when no file is active", () => {
    const data = buildReviewExtendData([inlineThread()], null);

    expect(data.oldFile).toEqual({});
    expect(data.newFile).toEqual({});
  });

  it("produces empty maps for zero threads — nothing can bleed into the diff", () => {
    expect(buildReviewExtendData([], "src/a.ts")).toEqual({
      oldFile: {},
      newFile: {},
    });
  });
});

describe("anchorSideOf — SplitSide to wire side", () => {
  it("maps SplitSide.old to 'old'", () => {
    expect(anchorSideOf(SplitSide.old)).toBe("old");
  });

  it("maps SplitSide.new to 'new'", () => {
    expect(anchorSideOf(SplitSide.new)).toBe("new");
  });
});
