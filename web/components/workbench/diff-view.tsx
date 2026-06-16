"use client";

import type { ReactElement } from "react";
import type { DiffViewProps as GitDiffViewProps } from "@git-diff-view/react";

import {
  DiffFile,
  DiffModeEnum,
  DiffView as GitDiffView,
  SplitSide,
} from "@git-diff-view/react";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { OutdatedThreadsSection } from "@/components/workbench/outdated-threads";
import { ReviewCommentComposer } from "@/components/workbench/review-comment-composer";
import {
  ReviewThreadStack,
  type ReviewCommentSide,
  type ReviewCommentsLabels,
  type ReviewThread,
  type ReviewThreadActions,
} from "@/components/workbench/review-thread-card";
import {
  buildRunDiffFileHref,
  buildRunHref,
  type RunDiffBodyMode,
  type RunDiffFileTreeMode,
} from "@/lib/runs/run-query-state";
import { useTheme } from "@/lib/theme";

import "@git-diff-view/react/styles/diff-view.css";

// Re-exported so the review-mode owner (run-diff, next slice) and tests can
// import the whole contract from one module.
export type {
  ReviewCommentDto,
  ReviewCommentSide,
  ReviewCommentStatus,
  ReviewCommentsLabels,
  ReviewThread,
  ReviewThreadActions,
  ReviewThreadPlacement,
} from "@/components/workbench/review-thread-card";

// TYPE-only mirror of the server prep DTO so this client component pulls no
// server code (`@/lib/diff/prepare` is "server-only"). Kept structurally in sync
// with `DiffFileSummary` / `PreparedFile` in that module.
export type DiffFileSummary = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type PreparedFile = {
  path: string;
  fileLang: string;
  bundle: ReturnType<DiffFile["_getFullBundle"]>;
};

export type DiffViewMode = "split" | "unified";
export type DiffBodyMode = RunDiffBodyMode;
export type DiffFileTreeMode = RunDiffFileTreeMode;

export interface DiffViewLabels {
  empty: string;
  bodyUnavailable: string;
  added: string;
  removed: string;
  displayMode: string;
  rich: string;
  raw: string;
  filterFiles: string;
  filterFilesPlaceholder: string;
  filterNoMatches: string;
  showFiles: string;
  hideFiles: string;
  refresh: string;
  viewMode: string;
  split: string;
  unified: string;
  truncated: string;
}

export interface RunDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

// The list tolerates entries whose counts are absent (renders 0) — the strict
// server DTO (`RunDiffFile`) always supplies them.
export type ChangedFileEntry = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
};

type ChangedFileTreeNode =
  | {
      kind: "dir";
      name: string;
      path: string;
      children: ChangedFileTreeNode[];
    }
  | {
      kind: "file";
      name: string;
      path: string;
      file: ChangedFileEntry;
    };

export interface ChangedFilesListProps {
  files: ChangedFileEntry[];
  labels: {
    empty: string;
    filterFiles?: string;
    filterFilesPlaceholder?: string;
    filterNoMatches?: string;
    added?: string;
    removed?: string;
  };
  filter?: string;
  selectedPath?: string | null;
  onFilterChange?: (value: string) => void;
  onSelect?: (path: string) => void;
}

function splitRepoPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function sortTreeNodes(nodes: ChangedFileTreeNode[]): ChangedFileTreeNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;

      return a.name.localeCompare(b.name);
    })
    .map((node) =>
      node.kind === "dir"
        ? { ...node, children: sortTreeNodes(node.children) }
        : node,
    );
}

function findDirNode(
  nodes: ChangedFileTreeNode[],
  name: string,
  path: string,
): ChangedFileTreeNode | null {
  return (
    nodes.find(
      (node) => node.kind === "dir" && node.name === name && node.path === path,
    ) ?? null
  );
}

export function buildChangedFileTree(
  files: ChangedFileEntry[],
): ChangedFileTreeNode[] {
  const root: ChangedFileTreeNode[] = [];
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const segments = splitRepoPath(file.path);
    let children = root;
    let currentPath = "";

    for (const [index, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      if (index === segments.length - 1) {
        children.push({
          kind: "file",
          name: segment,
          path: file.path,
          file,
        });

        continue;
      }

      const existing = findDirNode(children, segment, currentPath);

      if (existing?.kind === "dir") {
        children = existing.children;

        continue;
      }

      const nextDir: ChangedFileTreeNode = {
        kind: "dir",
        name: segment,
        path: currentPath,
        children: [],
      };

      children.push(nextDir);
      children = nextDir.children;
    }
  }

  return sortTreeNodes(root);
}

export function filterChangedFilesByName(
  files: ChangedFileEntry[],
  filter: string,
): ChangedFileEntry[] {
  const needle = filter.trim().toLocaleLowerCase();

  if (needle.length === 0) return files;

  return files.filter((file) => file.path.toLocaleLowerCase().includes(needle));
}

function DirTreeIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3 shrink-0 text-mute"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M2 4.5h4l1.25 1.25H14v6.75H2z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function FileTreeLeafIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3 shrink-0 text-mute"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M4 2.5h5l3 3V13.5H4zM9 2.5V6h3"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function ChangedFileTree({
  nodes,
  labels,
  selectedPath,
  depth = 0,
  onSelect,
}: {
  nodes: ChangedFileTreeNode[];
  labels: { added?: string; removed?: string };
  selectedPath: string | null;
  depth?: number;
  onSelect?: (path: string) => void;
}): ReactElement {
  return (
    <ul
      className="m-0 flex list-none flex-col gap-0.5 p-0"
      role={depth === 0 ? "tree" : "group"}
    >
      {nodes.map((node) => (
        <li key={node.path} role="none">
          {node.kind === "dir" ? (
            <>
              <div
                aria-expanded="true"
                aria-selected="false"
                className="flex items-center gap-1.5 rounded-[6px] py-1 pr-2 font-mono text-[11px] font-semibold text-mute"
                data-testid="changed-file-dir"
                role="treeitem"
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                title={node.path}
              >
                <DirTreeIcon />
                <span className="truncate">{node.name}</span>
              </div>
              <ChangedFileTree
                depth={depth + 1}
                labels={labels}
                nodes={node.children}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            </>
          ) : (
            <button
              aria-current={node.path === selectedPath ? "true" : undefined}
              aria-selected={node.path === selectedPath}
              className="flex w-full items-center gap-1.5 rounded-[6px] py-1 pr-2 text-left font-mono text-[11px] text-ink-2 hover:bg-ivory aria-[current]:bg-ivory"
              data-selected={node.path === selectedPath ? "true" : undefined}
              data-status={node.file.status}
              data-testid="changed-file"
              role="treeitem"
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              title={node.path}
              type="button"
              onClick={() => onSelect?.(node.path)}
            >
              <span className="w-3 shrink-0 text-center font-bold text-mute">
                {node.file.status}
              </span>
              <FileTreeLeafIcon />
              <span className="min-w-0 grow truncate">{node.name}</span>
              <span
                aria-label={labels.added}
                className="shrink-0 font-semibold text-[#1a7f37] dark:text-[#3fb950]"
                data-testid="changed-file-additions"
              >
                +{node.file.additions ?? 0}
              </span>
              <span
                aria-label={labels.removed}
                className="shrink-0 font-semibold text-[#cf222e] dark:text-[#f85149]"
                data-testid="changed-file-deletions"
              >
                −{node.file.deletions ?? 0}
              </span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ChangedFilesList({
  files,
  labels,
  filter = "",
  selectedPath = null,
  onFilterChange,
  onSelect,
}: ChangedFilesListProps): ReactElement {
  if (files.length === 0) {
    return (
      <p
        className="p-4 text-center font-mono text-[11px] text-mute"
        data-testid="changed-files-empty"
      >
        {labels.empty}
      </p>
    );
  }

  const filteredFiles = filterChangedFilesByName(files, filter);
  const tree = buildChangedFileTree(filteredFiles);

  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <input
        aria-label={labels.filterFiles}
        className="h-7 w-full rounded-[6px] border border-line bg-ivory px-2 font-mono text-[11px] text-ink outline-none placeholder:text-mute focus:border-ink"
        data-testid="changed-files-filter"
        placeholder={labels.filterFilesPlaceholder}
        readOnly={onFilterChange === undefined}
        type="search"
        value={filter}
        onChange={(event) => onFilterChange?.(event.target.value)}
      />
      {filteredFiles.length === 0 ? (
        <p
          className="p-4 text-center font-mono text-[11px] text-mute"
          data-testid="changed-files-filter-empty"
        >
          {labels.filterNoMatches ?? labels.empty}
        </p>
      ) : (
        <ChangedFileTree
          labels={{ added: labels.added, removed: labels.removed }}
          nodes={tree}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

// The anchor of a NEW root comment: the clicked diff line of the active file
// (`side`: `old` = base, `new` = branch; `line` 1-based on that side).
export type ReviewCommentAnchor = {
  filePath: string;
  side: ReviewCommentSide;
  line: number;
};

// PR-grade review mode (ADR-071). Pure presentation + callbacks: the owner
// (run-diff) fetches threads, performs the mutations, and refetches —
// no data fetching happens inside the diff renderer.
export interface DiffViewReview extends ReviewThreadActions {
  threads: ReviewThread[];
  currentUserId: string | null;
  canComment: boolean;
  busy?: boolean;
  onCreateRoot: (
    anchor: ReviewCommentAnchor,
    body: string,
  ) => void | Promise<void>;
  labels: ReviewCommentsLabels;
}

export type ReviewExtendData = {
  oldFile: Record<string, { data: ReviewThread[] }>;
  newFile: Record<string, { data: ReviewThread[] }>;
};

// Inline threads of the ACTIVE file keyed the way the native git-diff-view
// comment API expects: per diff side, by String(line) (ADR-071 D8). Outdated
// placements and other files' threads never reach extendData.
export function buildReviewExtendData(
  threads: ReviewThread[],
  activePath: string | null,
): ReviewExtendData {
  const oldFile: ReviewExtendData["oldFile"] = {};
  const newFile: ReviewExtendData["newFile"] = {};

  if (activePath !== null) {
    for (const thread of threads) {
      const { root } = thread;

      if (thread.placement !== "inline") continue;
      if (root.filePath !== activePath) continue;
      if (root.side === null || root.line === null) continue;

      const bucket = root.side === "old" ? oldFile : newFile;
      const key = String(root.line);

      (bucket[key] ??= { data: [] }).data.push(thread);
    }
  }

  return { oldFile, newFile };
}

export function anchorSideOf(side: SplitSide): ReviewCommentSide {
  return side === SplitSide.old ? "old" : "new";
}

export interface DiffViewProps {
  files: RunDiffFile[];
  perFile: PreparedFile[];
  labels: DiffViewLabels;
  // Optional explicit override; otherwise resolved from `?diffview=`.
  mode?: DiffViewMode;
  // Optional explicit override; otherwise resolved from `?diffbody=`.
  bodyMode?: DiffBodyMode;
  fileTreeMode?: DiffFileTreeMode;
  // Deprecated transport compatibility: the API still returns unified diff text
  // for preparation, but the client never renders it as a user-facing raw mode.
  rawDiff?: string;
  onRefresh?: () => void;
  // The producing diff was cut at the 4 MiB buffer bound: `files`/`perFile` are
  // a partial prefix. Surfaces a blocking banner so a partial diff is never read
  // as the whole change.
  truncated?: boolean;
  renderUnavailable?: boolean;
  // Review mode (ADR-071): inline threads render on the diff via extendData,
  // the add-widget composer opens on line click (canComment), and outdated
  // threads list in a collapsible section below the diff. Absent → the
  // renderer behaves exactly as before.
  review?: DiffViewReview;
}

function parseDiffView(raw: string | null): DiffViewMode {
  return raw === "unified" ? "unified" : "split";
}

function parseDiffBody(raw: string | null): DiffBodyMode {
  return raw === "raw" ? "raw" : "rich";
}

function parseDiffFileTree(raw: string | null): DiffFileTreeMode {
  return raw === "hidden" ? "hidden" : "shown";
}

function toolbarButtonClass(active: boolean): string {
  return [
    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border border-transparent text-ink-2 hover:bg-ivory hover:text-ink focus-visible:border-ink focus-visible:outline-none",
    active ? "border-line bg-ivory text-ink" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

type ToolbarIconButtonProps = {
  label: string;
  testId: string;
  icon: ReactElement;
  pressed?: boolean;
  onClick: () => void;
};

function ToolbarIconButton({
  label,
  testId,
  icon,
  pressed,
  onClick,
}: ToolbarIconButtonProps): ReactElement {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={toolbarButtonClass(pressed === true)}
      data-testid={testId}
      title={label}
      type="button"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function RichDiffIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M3 3.5h10M3 6.5h6M3 9.5h10M3 12.5h7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function RawDiffIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="m6 4-4 4 4 4M10 4l4 4-4 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function SplitDiffIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M2.75 3.25h10.5v9.5H2.75zM8 3.25v9.5"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function UnifiedDiffIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M3 3.25h10v9.5H3zM5 6h6M5 8h6M5 10h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function FileTreeIcon({ hidden }: { hidden: boolean }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M3 3.25h4.25L8.5 4.75H13v8H3z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M5 7h6M5 9h4M5 11h5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.2"
      />
      {hidden ? (
        <path
          d="M3 13 13 3"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      ) : null}
    </svg>
  );
}

function RefreshIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M12.5 5.25A5 5 0 1 0 13 9M12.5 5.25V2.75M12.5 5.25H10"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

// The committed run-branch diff, rendered by git-diff-view. The per-file syntax
// bundle is built SERVER-SIDE (`lib/diff/prepare.ts`, Shiki) as a FULL bundle
// (carries `oldFileResult`/`newFileResult`) and hydrated here via
// `DiffFile.createInstance(data, fullBundle)` → `_mergeFullBundle`. We pass
// `diffViewHighlight={true}` with NO `registerHighlighter`: git-diff-view's
// `initSyntax()` early-return restores the already-merged dual-theme syntax
// WITHOUT invoking any highlighter, so Shiki never runs in the browser and the
// lowlight stub is never called (FINDING G — no highlighter ships to the
// client). The tokens carry `--shiki-light`/`--shiki-dark` CSS vars and recolor
// on the light/dark toggle via the diff-scoped rule in globals.css.
// The optional `review` prop group (ADR-071) layers the native git-diff-view
// comment API on top: extendData/renderExtendLine for inline threads,
// diffViewAddWidget/renderWidgetLine for the composer.
export function DiffView({
  files,
  perFile,
  labels,
  mode,
  bodyMode,
  fileTreeMode,
  onRefresh,
  truncated = false,
  renderUnavailable = false,
  review,
}: DiffViewProps): ReactElement {
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewMode: DiffViewMode =
    mode ?? parseDiffView(searchParams?.get("diffview") ?? null);
  const diffBodyMode: DiffBodyMode =
    bodyMode ?? parseDiffBody(searchParams?.get("diffbody") ?? null);
  const diffFileTreeMode: DiffFileTreeMode =
    fileTreeMode ?? parseDiffFileTree(searchParams?.get("diffFiles") ?? null);
  const fileTreeVisible = diffFileTreeMode === "shown";
  const [fileFilter, setFileFilter] = useState("");

  const setViewMode = (next: DiffViewMode): void => {
    router.push(
      buildRunHref(pathname, searchParams?.toString() ?? "", {
        diffview: next,
      }),
      { scroll: false },
    );
  };

  const setBodyMode = (next: DiffBodyMode): void => {
    router.push(
      buildRunHref(pathname, searchParams?.toString() ?? "", {
        diffbody: next,
      }),
      { scroll: false },
    );
  };

  const setFileTreeMode = (next: DiffFileTreeMode): void => {
    router.push(
      buildRunHref(pathname, searchParams?.toString() ?? "", {
        diffFiles: next,
      }),
      { scroll: false },
    );
  };

  const requestedDiffFile = searchParams?.get("diffFile") ?? null;
  const initialSelected =
    perFile.find((file) => file.path === requestedDiffFile)?.path ??
    perFile[0]?.path ??
    null;
  const [selected, setSelected] = useState<string | null>(initialSelected);

  const activePath = selected ?? perFile[0]?.path ?? null;
  const active = perFile.find((f) => f.path === activePath) ?? null;

  useEffect(() => {
    if (!requestedDiffFile) return;
    if (!perFile.some((file) => file.path === requestedDiffFile)) return;
    setSelected(requestedDiffFile);
  }, [requestedDiffFile, perFile]);

  const selectDiffFile = (path: string): void => {
    setSelected(path);
    router.push(
      buildRunDiffFileHref(pathname, searchParams?.toString() ?? "", path),
      { scroll: false },
    );
  };

  const diffFile = useMemo(() => {
    if (!active) return null;

    return DiffFile.createInstance(
      {
        oldFile: { fileName: active.path, fileLang: active.fileLang },
        newFile: { fileName: active.path, fileLang: active.fileLang },
      },
      active.bundle,
    );
  }, [active]);

  const diffViewMode =
    viewMode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.Split;
  const diffTheme: "light" | "dark" =
    resolvedTheme === "light" ? "light" : "dark";
  const diffViewHighlight = diffBodyMode === "rich";
  const nextBodyMode: DiffBodyMode = diffBodyMode === "rich" ? "raw" : "rich";
  const nextViewMode: DiffViewMode = viewMode === "split" ? "unified" : "split";

  const reviewExtendData = useMemo(
    () => (review ? buildReviewExtendData(review.threads, activePath) : null),
    [review, activePath],
  );

  // Spread onto GitDiffView only in review mode so the review-off render
  // stays byte-identical to the pre-review component. Memoized so the
  // renderExtendLine / renderWidgetLine closures keep a stable identity across
  // re-renders that don't change the review payload or the active file.
  const reviewDiffProps = useMemo<
    Partial<
      Pick<
        GitDiffViewProps<ReviewThread[]>,
        | "extendData"
        | "renderExtendLine"
        | "diffViewAddWidget"
        | "onAddWidgetClick"
        | "renderWidgetLine"
      >
    >
  >(
    () =>
      review && reviewExtendData
        ? {
            extendData: reviewExtendData,
            renderExtendLine: ({ data }) => (
              <ReviewThreadStack
                actions={review}
                busy={review.busy}
                canComment={review.canComment}
                currentUserId={review.currentUserId}
                labels={review.labels}
                threads={data}
              />
            ),
            ...(review.canComment && activePath !== null
              ? {
                  diffViewAddWidget: true,
                  // The composer anchor arrives via renderWidgetLine args and
                  // the lib opens/closes the widget internally — the click
                  // notification needs no extra state here.
                  onAddWidgetClick: () => undefined,
                  renderWidgetLine: ({ side, lineNumber, onClose }) => (
                    <div className="p-2" data-testid="review-widget">
                      <ReviewCommentComposer
                        busy={review.busy}
                        labels={{
                          placeholder: review.labels.composerPlaceholder,
                          submit: review.labels.composerSubmit,
                          cancel: review.labels.composerCancel,
                        }}
                        onCancel={onClose}
                        onSubmit={async (body) => {
                          await review.onCreateRoot(
                            {
                              filePath: activePath,
                              side: anchorSideOf(side),
                              line: lineNumber,
                            },
                            body,
                          );
                          onClose();
                        }}
                      />
                    </div>
                  ),
                }
              : {}),
          }
        : {},
    [review, reviewExtendData, activePath],
  );

  return (
    <div className="flex flex-col gap-2" data-testid="diff-view-wrap">
      {truncated ? (
        <p
          className="rounded-[10px] border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] leading-[1.5] text-amber"
          data-testid="diff-truncated-banner"
          role="alert"
        >
          {labels.truncated}
        </p>
      ) : null}
      <div
        className={[
          "grid min-h-[520px] max-h-[calc(100vh-260px)] grid-cols-1 overflow-hidden rounded-[10px] border border-line bg-paper",
          fileTreeVisible
            ? "md:grid-cols-[minmax(220px,320px)_minmax(0,1fr)]"
            : "md:grid-cols-1",
        ].join(" ")}
        data-diff-body-mode={diffBodyMode}
        data-diff-file-tree-mode={diffFileTreeMode}
        data-diff-mode={viewMode}
        data-review-can-comment={
          review?.canComment && activePath !== null ? "true" : undefined
        }
        data-testid="diff-view"
      >
        {fileTreeVisible ? (
          <aside
            className="min-h-0 overflow-hidden border-b border-line bg-paper md:border-b-0 md:border-r"
            data-testid="diff-view-file-list"
          >
            <div className="h-full min-h-0 overflow-auto p-1.5">
              <ChangedFilesList
                files={files}
                filter={fileFilter}
                labels={{
                  empty: labels.empty,
                  filterFiles: labels.filterFiles,
                  filterFilesPlaceholder: labels.filterFilesPlaceholder,
                  filterNoMatches: labels.filterNoMatches,
                  added: labels.added,
                  removed: labels.removed,
                }}
                selectedPath={activePath}
                onFilterChange={setFileFilter}
                onSelect={selectDiffFile}
              />
            </div>
          </aside>
        ) : null}
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div
            className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper/95 px-2 py-1.5 backdrop-blur"
            data-testid="diff-view-toolbar"
          >
            {activePath ? (
              <span className="min-w-0 truncate font-mono text-[11px] font-semibold text-ink">
                {activePath}
              </span>
            ) : (
              <span className="font-mono text-[11px] font-semibold text-mute">
                {labels.empty}
              </span>
            )}
            <div className="flex flex-wrap items-center gap-1">
              <ToolbarIconButton
                icon={
                  nextBodyMode === "raw" ? <RawDiffIcon /> : <RichDiffIcon />
                }
                label={nextBodyMode === "raw" ? labels.raw : labels.rich}
                pressed={diffBodyMode === "raw"}
                testId="diff-view-body-toggle"
                onClick={() => setBodyMode(nextBodyMode)}
              />
              <ToolbarIconButton
                icon={
                  nextViewMode === "unified" ? (
                    <UnifiedDiffIcon />
                  ) : (
                    <SplitDiffIcon />
                  )
                }
                label={
                  nextViewMode === "unified" ? labels.unified : labels.split
                }
                pressed={viewMode === "unified"}
                testId="diff-view-layout-toggle"
                onClick={() => setViewMode(nextViewMode)}
              />
              <ToolbarIconButton
                icon={<FileTreeIcon hidden={fileTreeVisible} />}
                label={fileTreeVisible ? labels.hideFiles : labels.showFiles}
                pressed={!fileTreeVisible}
                testId="diff-view-files-toggle"
                onClick={() =>
                  setFileTreeMode(fileTreeVisible ? "hidden" : "shown")
                }
              />
              {onRefresh ? (
                <ToolbarIconButton
                  icon={<RefreshIcon />}
                  label={labels.refresh}
                  testId="diff-view-refresh"
                  onClick={onRefresh}
                />
              ) : null}
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto"
            data-testid="diff-view-rich"
          >
            {diffFile ? (
              // `key` remounts git-diff-view on theme/body-mode toggle so the
              // wrapper chrome and highlight mode re-apply without fetching or
              // re-preparing the diff. The full bundle already carries syntax.
              <GitDiffView<ReviewThread[]>
                key={`${diffTheme}-${diffBodyMode}`}
                diffFile={diffFile}
                diffViewHighlight={diffViewHighlight}
                diffViewMode={diffViewMode}
                diffViewTheme={diffTheme}
                diffViewWrap={false}
                {...reviewDiffProps}
              />
            ) : renderUnavailable && files.length > 0 ? (
              <p
                className="p-4 text-center font-mono text-[11px] leading-[1.5] text-mute"
                data-testid="diff-view-body-unavailable"
              >
                {labels.bodyUnavailable}
              </p>
            ) : (
              <p
                className="p-4 text-center font-mono text-[11px] text-mute"
                data-testid="diff-view-empty"
              >
                {labels.empty}
              </p>
            )}
          </div>
        </section>
      </div>
      {review ? (
        <OutdatedThreadsSection
          actions={review}
          busy={review.busy}
          canComment={review.canComment}
          currentUserId={review.currentUserId}
          labels={review.labels}
          threads={review.threads}
        />
      ) : null}
    </div>
  );
}
