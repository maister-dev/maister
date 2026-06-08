"use client";

import type { ReactElement } from "react";

import { useEffect, useState } from "react";

import {
  ChangedFilesList,
  DiffView,
  type PreparedFile,
  type RunDiffFile,
} from "@/components/workbench/diff-view";

export { ChangedFilesList };
export type { RunDiffFile };

export interface RunDiffLabels {
  title: string;
  empty: string;
  error: string;
  changedFiles: string;
  added: string;
  removed: string;
  viewMode: string;
  split: string;
  unified: string;
}

export interface RunDiffProps {
  runId: string;
  labels: RunDiffLabels;
}

type DiffState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; files: RunDiffFile[]; perFile: PreparedFile[] };

export default function RunDiff({ runId, labels }: RunDiffProps): ReactElement {
  const [state, setState] = useState<DiffState>({ kind: "loading" });

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
          files?: RunDiffFile[];
          perFile?: PreparedFile[];
        };

        if (!cancelled) {
          setState({
            kind: "ready",
            files: body.files ?? [],
            perFile: body.perFile ?? [],
          });
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

  return (
    <div data-testid="run-diff">
      <p className="mb-2 px-2 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-mute">
        {labels.changedFiles}
      </p>
      <DiffView
        files={state.files}
        labels={{
          empty: labels.empty,
          added: labels.added,
          removed: labels.removed,
          viewMode: labels.viewMode,
          split: labels.split,
          unified: labels.unified,
        }}
        perFile={state.perFile}
      />
    </div>
  );
}
