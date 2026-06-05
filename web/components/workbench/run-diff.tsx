"use client";

import type { ReactElement } from "react";

import { useEffect, useState } from "react";

import { RawDiff } from "@/components/runs/raw-diff";

export type RunDiffFile = { path: string; status: string };

export interface RunDiffLabels {
  title: string;
  empty: string;
  error: string;
  changedFiles: string;
}

// A unified diff is concatenated per-file sections each starting with
// "diff --git a/<old> b/<new>". Return only the selected file's section so a
// changed-files click filters the <pre> to that file; fall back to the full
// diff when the path is not found.
export function extractFileSection(diff: string, path: string): string {
  const sections = diff.split(/\n(?=diff --git )/);
  const match = sections.find(
    (s) =>
      s.startsWith("diff --git") && s.split("\n", 1)[0].endsWith(` b/${path}`),
  );

  return match ?? diff;
}

export interface ChangedFilesListProps {
  files: RunDiffFile[];
  labels: { empty: string };
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
            <span className="truncate">{file.path}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface RunDiffProps {
  runId: string;
  labels: RunDiffLabels;
}

type DiffState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; diff: string; files: RunDiffFile[] };

export default function RunDiff({ runId, labels }: RunDiffProps): ReactElement {
  const [state, setState] = useState<DiffState>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const res = await fetch(`/api/runs/${runId}/diff`);

        if (!res.ok) {
          if (!cancelled) setState({ kind: "error" });

          return;
        }
        const body = (await res.json()) as {
          diff: string;
          files?: RunDiffFile[];
        };

        if (!cancelled) {
          setState({ kind: "ready", diff: body.diff, files: body.files ?? [] });
        }
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (state.kind === "loading") {
    return (
      <p
        className="p-4 text-center font-mono text-[11px] text-mute"
        data-testid="run-diff-loading"
      >
        {labels.title}
      </p>
    );
  }

  if (state.kind === "error") {
    return (
      <p
        className="p-4 text-center font-mono text-[11px] text-rust"
        data-testid="run-diff-error"
        role="alert"
      >
        {labels.error}
      </p>
    );
  }

  const shownDiff = selected
    ? extractFileSection(state.diff, selected)
    : state.diff;

  return (
    <div
      className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(200px,280px)_1fr]"
      data-testid="run-diff"
    >
      <div className="overflow-auto rounded-[10px] border border-line bg-paper p-1.5">
        <p className="px-2 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
          {labels.changedFiles}
        </p>
        <ChangedFilesList
          files={state.files}
          labels={{ empty: labels.empty }}
          selectedPath={selected}
          onSelect={(path) =>
            setSelected((prev) => (prev === path ? null : path))
          }
        />
      </div>
      <RawDiff diff={shownDiff} />
    </div>
  );
}
