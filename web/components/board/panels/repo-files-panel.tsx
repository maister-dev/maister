import type { FileTreeLabels } from "@/components/workbench/file-tree";
import type { ReactElement } from "react";

import pino from "pino";

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
}

export interface RepoFilesPanelProps {
  slug: string;
  projectId: string;
  repoPath: string;
  mainBranch: string;
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
      <div className={STATE_CLASS} data-testid="file-empty">
        {labels.empty}
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
      ref: mainBranch,
      path: file,
      maxBytes: workbenchMaxFileBytes(),
    });

    pane = await CodeView({ blob, labels, path: file });
  }

  return (
    <section>
      <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
        {labels.title}
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(220px,300px)_1fr]">
        <FileTree
          filesApiBase={`/api/projects/${slug}/files`}
          labels={labels}
        />
        {pane}
      </div>
    </section>
  );
}
