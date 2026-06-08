"use client";

import type { ReactElement } from "react";

import {
  DiffFile,
  DiffModeEnum,
  DiffView as GitDiffView,
} from "@git-diff-view/react";
import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useTheme } from "@/lib/theme";

import "@git-diff-view/react/styles/diff-view.css";

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

export interface DiffViewLabels {
  empty: string;
  added: string;
  removed: string;
  viewMode: string;
  split: string;
  unified: string;
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

export interface ChangedFilesListProps {
  files: ChangedFileEntry[];
  labels: { empty: string; added?: string; removed?: string };
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
}

export function ChangedFilesList({
  files,
  labels,
  selectedPath = null,
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

  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {files.map((file) => (
        <li key={`${file.status}-${file.path}`}>
          <button
            aria-current={file.path === selectedPath ? "true" : undefined}
            className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left font-mono text-[11px] text-ink-2 hover:bg-ivory aria-[current]:bg-ivory"
            data-selected={file.path === selectedPath ? "true" : undefined}
            data-status={file.status}
            data-testid="changed-file"
            type="button"
            onClick={() => onSelect?.(file.path)}
          >
            <span className="w-3 shrink-0 text-center font-bold text-mute">
              {file.status}
            </span>
            <span className="grow truncate">{file.path}</span>
            <span
              aria-label={labels.added}
              className="shrink-0 font-semibold text-[#1a7f37] dark:text-[#3fb950]"
              data-testid="changed-file-additions"
            >
              +{file.additions ?? 0}
            </span>
            <span
              aria-label={labels.removed}
              className="shrink-0 font-semibold text-[#cf222e] dark:text-[#f85149]"
              data-testid="changed-file-deletions"
            >
              −{file.deletions ?? 0}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface DiffViewProps {
  files: RunDiffFile[];
  perFile: PreparedFile[];
  labels: DiffViewLabels;
  // Optional explicit override; otherwise resolved from `?diffview=`.
  mode?: DiffViewMode;
}

function parseDiffView(raw: string | null): DiffViewMode {
  return raw === "unified" ? "unified" : "split";
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
// extendData / DiffViewWithMultiSelect stay reachable for the future code-review
// comment surface; no comment UI is built here.
export function DiffView({
  files,
  perFile,
  labels,
  mode,
}: DiffViewProps): ReactElement {
  const { resolvedTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewMode: DiffViewMode =
    mode ?? parseDiffView(searchParams?.get("diffview") ?? null);

  const setViewMode = (next: DiffViewMode): void => {
    const params = new URLSearchParams(searchParams ?? undefined);

    params.set("diffview", next);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const [selected, setSelected] = useState<string | null>(
    perFile[0]?.path ?? null,
  );

  const activePath = selected ?? perFile[0]?.path ?? null;
  const active = perFile.find((f) => f.path === activePath) ?? null;

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

  return (
    <div
      className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(200px,280px)_1fr]"
      data-diff-mode={viewMode}
      data-testid="diff-view"
    >
      <div className="overflow-auto rounded-[10px] border border-line bg-paper p-1.5">
        <ChangedFilesList
          files={files}
          labels={{
            empty: labels.empty,
            added: labels.added,
            removed: labels.removed,
          }}
          selectedPath={activePath}
          onSelect={setSelected}
        />
      </div>
      <div className="min-w-0 overflow-auto rounded-[10px] border border-line bg-paper">
        <div
          aria-label={labels.viewMode}
          className="flex justify-end gap-1 border-b border-line p-1.5"
          role="group"
        >
          <button
            aria-pressed={viewMode === "split"}
            className="rounded-[6px] px-2 py-1 font-mono text-[11px] text-ink-2 hover:bg-ivory aria-[pressed=true]:bg-ivory aria-[pressed=true]:font-semibold"
            data-testid="diff-view-mode-split"
            type="button"
            onClick={() => setViewMode("split")}
          >
            {labels.split}
          </button>
          <button
            aria-pressed={viewMode === "unified"}
            className="rounded-[6px] px-2 py-1 font-mono text-[11px] text-ink-2 hover:bg-ivory aria-[pressed=true]:bg-ivory aria-[pressed=true]:font-semibold"
            data-testid="diff-view-mode-unified"
            type="button"
            onClick={() => setViewMode("unified")}
          >
            {labels.unified}
          </button>
        </div>
        {diffFile ? (
          // `key={diffTheme}` remounts git-diff-view on theme toggle so the
          // wrapper's `data-theme` chrome re-applies. The remount re-hydrates
          // from the full bundle (no re-highlight); the syntax tokens recolor
          // instantly via the `--shiki-*` CSS vars regardless.
          <GitDiffView
            key={diffTheme}
            diffFile={diffFile}
            diffViewHighlight={true}
            diffViewMode={diffViewMode}
            diffViewTheme={diffTheme}
            diffViewWrap={false}
          />
        ) : (
          <p
            className="p-4 text-center font-mono text-[11px] text-mute"
            data-testid="diff-view-empty"
          >
            {labels.empty}
          </p>
        )}
      </div>
    </div>
  );
}
