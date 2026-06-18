import type { FileTreeLabels } from "@/components/workbench/file-tree";
import type { ReactElement } from "react";

import pino from "pino";

import { BranchSelect } from "@/components/workbench/branch-select";
import {
  CodeView,
  type CodeViewLabels,
} from "@/components/workbench/code-view";
import FileTree from "@/components/workbench/file-tree";
import { requireProjectAction } from "@/lib/authz";
import { workbenchMaxFileBytes } from "@/lib/instance-config";
import { readBlob, repoRelPathSchema } from "@/lib/worktree";

const log = pino({
  name: "repo-files-panel",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface RepoFilesLabels extends FileTreeLabels, CodeViewLabels {
  title: string;
  forbidden: string;
  selectPrompt: string;
  branchLabel: string;
}

export interface RepoFilesPanelProps {
  slug: string;
  projectId: string;
  repoPath: string;
  mainBranch: string;
  currentRef: string;
  branches: string[];
  file: string | null;
  canReadRepoFiles: boolean;
  labels: RepoFilesLabels;
}

const STATE_CLASS =
  "rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute";

// The project-board repo tab mirrors the run-detail workbench `?file=` read
// (ADR-066): the client file tree navigates `?file=<path>` and this server pane
// re-reads the project's default-branch blob. Read order is fixed — auth
// (readRepoFiles, server-derived projectId) BEFORE the read, repoRelPathSchema
// BEFORE readBlob — and a rejected path surfaces the not-found state, never the
// path. `ref` is the project default branch (server-state).
export async function RepoFilesPanel({
  slug,
  projectId,
  repoPath,
  mainBranch,
  currentRef,
  branches,
  file,
  canReadRepoFiles,
  labels,
}: RepoFilesPanelProps): Promise<ReactElement> {
  if (!canReadRepoFiles) {
    return (
      <div
        className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute"
        data-testid="repo-files-forbidden"
      >
        {labels.forbidden}
      </div>
    );
  }

  await requireProjectAction(projectId, "readRepoFiles");

  let pane: ReactElement;

  if (file === null) {
    pane = (
      <div className={STATE_CLASS} data-testid="file-select-prompt">
        {labels.selectPrompt}
      </div>
    );
  } else if (!repoRelPathSchema.safeParse(file).success) {
    log.warn({ slug, projectId }, "invalid ?file= path");
    pane = (
      <div className={STATE_CLASS} data-testid="file-not-found" role="alert">
        {labels.notFound}
      </div>
    );
  } else {
    const blob = await readBlob({
      repo: repoPath,
      ref: currentRef,
      path: file,
      maxBytes: workbenchMaxFileBytes(),
    });

    pane = await CodeView({ blob, labels, path: file });
  }

  return (
    <section>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
          {labels.title}
        </h2>
        {branches.length > 0 ? (
          <BranchSelect
            branches={branches}
            current={currentRef}
            defaultBranch={mainBranch}
            label={labels.branchLabel}
          />
        ) : null}
      </header>
      {/* No fixed height/scroll: align-items:stretch makes both columns share
          the row height, so the file pane grows to match an expanding tree
          (the page scrolls, not the panes). min-h floors short repos; the
          viewer fills the stretched column via !h-full (overriding CodeView's
          own max-h cap). */}
      <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-[minmax(220px,300px)_1fr]">
        <div className="min-h-[560px] [&>[data-testid=file-tree]]:h-full">
          <FileTree
            key={currentRef}
            filesApiBase={`/api/projects/${slug}/files`}
            gitRef={currentRef}
            labels={labels}
          />
        </div>
        <div className="min-h-[560px] [&_.markdown-rich-view]:!h-full [&_.markdown-rich-view]:!max-h-full [&_[data-testid=code-view]]:!h-full [&_[data-testid=code-view]]:!max-h-full">
          {pane}
        </div>
      </div>
    </section>
  );
}
