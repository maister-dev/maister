"use client";

import type { ReactElement } from "react";

import { useEffect, useState } from "react";

export type FileViewerState =
  | { kind: "text"; content: string }
  | { kind: "too-large"; size: number }
  | { kind: "binary" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "empty" };

export interface FileViewerLabels {
  tooLarge: string;
  binary: string;
  loadError: string;
  loading: string;
  empty: string;
}

export interface FileViewerBodyProps {
  state: FileViewerState;
  labels: FileViewerLabels;
}

export function FileViewerBody({
  state,
  labels,
}: FileViewerBodyProps): ReactElement {
  switch (state.kind) {
    case "text":
      return (
        <pre
          className="m-0 max-h-[420px] overflow-auto rounded-[8px] border border-line bg-ivory p-3 font-mono text-[11px] leading-[1.5] text-ink-2"
          data-testid="file-content"
        >
          {state.content}
        </pre>
      );
    case "too-large":
      return (
        <div
          className="rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute"
          data-testid="file-too-large"
        >
          {labels.tooLarge} ({state.size} bytes)
        </div>
      );
    case "binary":
      return (
        <div
          className="rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute"
          data-testid="file-binary"
        >
          {labels.binary}
        </div>
      );
    case "error":
      return (
        <div
          className="rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute"
          data-testid="file-error"
          role="alert"
        >
          {labels.loadError}
        </div>
      );
    case "loading":
      return (
        <div
          className="rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute"
          data-testid="file-loading"
        >
          {labels.loading}
        </div>
      );
    case "empty":
      return (
        <div
          className="rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute"
          data-testid="file-empty"
        >
          {labels.empty}
        </div>
      );
  }
}

export interface FileViewerProps {
  filesApiBase: string;
  path: string | null;
  labels: FileViewerLabels;
}

export function FileViewer({
  filesApiBase,
  path,
  labels,
}: FileViewerProps): ReactElement {
  const [state, setState] = useState<FileViewerState>({ kind: "empty" });

  useEffect(() => {
    if (path === null) {
      setState({ kind: "empty" });

      return;
    }

    let cancelled = false;

    setState({ kind: "loading" });

    async function load(target: string): Promise<void> {
      try {
        const res = await fetch(
          `${filesApiBase}/content?path=${encodeURIComponent(target)}`,
        );

        if (cancelled) return;

        if (res.status === 413) {
          const body = (await res.json()) as { size: number };

          if (!cancelled) setState({ kind: "too-large", size: body.size });

          return;
        }

        if (res.status === 415) {
          if (!cancelled) setState({ kind: "binary" });

          return;
        }

        if (!res.ok) {
          if (!cancelled) setState({ kind: "error" });

          return;
        }

        const body = (await res.json()) as { content: string };

        if (!cancelled) setState({ kind: "text", content: body.content });
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    }

    void load(path);

    return () => {
      cancelled = true;
    };
  }, [filesApiBase, path]);

  return <FileViewerBody labels={labels} state={state} />;
}
