import type { FileTreeLabels } from "@/components/workbench/file-tree";
import type { ReactElement } from "react";

import pino from "pino";

import { RepoFetchButton } from "@/components/board/panels/repo-fetch-button";
import { BranchSelect } from "@/components/workbench/branch-select";
import {
  CodeView,
  type CodeViewLabels,
} from "@/components/workbench/code-view";
import FileTree from "@/components/workbench/file-tree";
import { requireProjectAction } from "@/lib/authz";
import { workbenchMaxFileBytes } from "@/lib/instance-config";
import { localBranchHead, readBlob, repoRelPathSchema } from "@/lib/worktree";

const log = pino({
  name: "repo-files-panel",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface RepoFilesLabels extends FileTreeLabels, CodeViewLabels {
  title: string;
  forbidden: string;
  selectPrompt: string;
  branchLabel: string;
  fetchOrigin: string;
  fetching: string;
  fetchFailed: string;
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
  canFetch: boolean;
  labels: RepoFilesLabels;
}

const STATE_CLASS =
  "rounded-[8px] border border-dashed border-line bg-paper p-6 text-center font-mono text-[12px] text-mute";

// The project-board repo tab mirrors the run-detail workbench `?file=` read
// (ADR-066): the client file tree navigates `?file=<path>` and this server pane
// re-reads the selected branch's blob. Read order is fixed — auth
// (readRepoFiles, server-derived projectId) BEFORE the read, repoRelPathSchema
// BEFORE readBlob — and a rejected path surfaces the not-found state, never the
// path. Pin both panes to one commit so refreshed content and tree agree.
export async function RepoFilesPanel({
  slug,
  projectId,
  repoPath,
  mainBranch,
  currentRef,
  branches,
  file,
  canReadRepoFiles,
  canFetch,
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
  const revision = await localBranchHead({
    projectRepoPath: repoPath,
    branch: currentRef,
  });

  let pane: ReactElement;

  if (file === null) {
    pane = (
      <div className={STATE_CLASS} data-testid="file-select-prompt">
        {labels.selectPrompt}
      </div>
    );
  } else if (!revision || !repoRelPathSchema.safeParse(file).success) {
    log.warn({ slug, projectId, revision }, "repository file unavailable");
    pane = (
      <div className={STATE_CLASS} data-testid="file-not-found" role="alert">
        {labels.notFound}
      </div>
    );
  } else {
    const blob = await readBlob({
      repo: repoPath,
      ref: revision,
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
        <div className="flex flex-wrap items-center gap-2">
          {canFetch ? (
            <RepoFetchButton
              branch={currentRef}
              failedLabel={labels.fetchFailed}
              label={labels.fetchOrigin}
              pendingLabel={labels.fetching}
              slug={slug}
            />
          ) : null}
          {branches.length > 0 ? (
            <BranchSelect
              key={currentRef}
              branches={branches}
              current={currentRef}
              defaultBranch={mainBranch}
              label={labels.branchLabel}
            />
          ) : null}
        </div>
      </header>
      {/* No fixed height/scroll: align-items:stretch makes both columns share
          the row height, so the file pane grows to match an expanding tree
          (the page scrolls, not the panes). min-h floors short repos; the
          viewer fills the stretched column via !h-full (overriding CodeView's
          own max-h cap). */}
      <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-[minmax(220px,300px)_1fr]">
        <div className="min-h-[560px] [&>[data-testid=file-tree]]:h-full">
          {revision ? (
            <FileTree
              key={revision}
              filesApiBase={`/api/projects/${slug}/files`}
              gitRef={revision}
              labels={labels}
            />
          ) : (
            <div className={STATE_CLASS} role="alert">
              {labels.loadError}
            </div>
          )}
        </div>
        <div className="min-h-[560px] [&_.markdown-rich-view]:!h-full [&_.markdown-rich-view]:!max-h-full [&_[data-testid=code-view]]:!h-full [&_[data-testid=code-view]]:!max-h-full">
          {pane}
        </div>
      </div>
    </section>
  );
}
