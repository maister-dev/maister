import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import pino from "pino";

import {
  CodeView,
  type CodeViewLabels,
} from "@/components/workbench/code-view";
import { requireProjectAction } from "@/lib/authz";
import { workbenchMaxFileBytes } from "@/lib/instance-config";
import { getRunDetail } from "@/lib/queries/run";
import { readBlob, repoRelPathSchema } from "@/lib/worktree";

const log = pino({
  name: "run-file-pane",
  level: process.env.LOG_LEVEL ?? "info",
});

export function parseFilePaneFile(
  raw: string | string[] | undefined,
): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value && value.length > 0 ? value : null;
}

// The shared `?file=`-driven workbench pane for both flow/agent runs
// (`/runs/[runId]`) and scratch runs (`/scratch-runs/[runId]`) (M35 T3.1).
// This is the ONLY run-detail surface that re-renders on a `?file=` soft-nav:
// the heavy runId-scoped loads live in each route's persistent layout. Read
// order is fixed: auth (readRepoFiles, with a server-derived projectId) BEFORE
// the read, then repoRelPathSchema validation BEFORE readBlob, then <CodeView>.
// `ref` is the run branch (server-state); the `?file=` query value is the only
// untrusted input and is never disclosed on rejection.
export async function renderRunFilePane({
  runId,
  file,
}: {
  runId: string;
  file: string | null;
}): Promise<ReactElement> {
  const tWorkbench = await getTranslations("workbench");
  const labels: CodeViewLabels = {
    tooLarge: tWorkbench("files.tooLarge"),
    binary: tWorkbench("files.binary"),
    empty: tWorkbench("files.empty"),
    notFound: tWorkbench("files.notFound"),
  };

  const detail = await getRunDetail(runId);

  if (!detail) notFound();

  // Auth BEFORE any read; projectId is server-derived from the run row, never a
  // request field. Mirrors the retired files/content route's gate.
  await requireProjectAction(detail.projectId, "readRepoFiles");

  if (file === null) {
    return (
      <div
        className="rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute"
        data-testid="file-empty"
      >
        {labels.empty}
      </div>
    );
  }

  // repoRelPathSchema (the sink-invariant guard) BEFORE readBlob: a rejected
  // path surfaces the not-found state — never the rejected path itself.
  if (!repoRelPathSchema.safeParse(file).success) {
    log.warn({ runId, projectId: detail.projectId }, "invalid ?file= path");

    return (
      <div
        className="rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute"
        data-testid="file-not-found"
        role="alert"
      >
        {labels.notFound}
      </div>
    );
  }

  const blob = await readBlob({
    repo: detail.worktreePath,
    ref: detail.branch,
    path: file,
    maxBytes: workbenchMaxFileBytes(),
  });

  return CodeView({ blob, labels, path: file });
}
