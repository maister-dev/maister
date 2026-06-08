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
  name: "run-detail-file",
  level: process.env.LOG_LEVEL ?? "info",
});

type PageProps = {
  params: Promise<{ runId: string }>;
  searchParams: Promise<Record<string, string | string[]>>;
};

function parseFile(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  return value && value.length > 0 ? value : null;
}

// The `?file=`-driven workbench pane. This is the ONLY run-detail surface that
// re-renders on a `?file=` soft-nav (FINDING A): the heavy runId-scoped loads
// live in the persistent layout. Read order is fixed: auth (readRepoFiles, with
// a server-derived projectId) BEFORE the read, then repoRelPathSchema validation
// BEFORE readBlob, then <CodeView>. `ref` is the run branch (server-state); the
// `?file=` query value is the only untrusted input and is never disclosed on
// rejection.
export default async function RunFilePane({
  params,
  searchParams,
}: PageProps): Promise<ReactElement> {
  const { runId } = await params;
  const { file: rawFile } = await searchParams;
  const file = parseFile(rawFile);

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
