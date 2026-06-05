import type { FileTreeLabels } from "@/components/workbench/file-tree";
import type { ReactElement } from "react";

import FileTree from "@/components/workbench/file-tree";

export interface RepoFilesLabels extends FileTreeLabels {
  title: string;
  forbidden: string;
}

export interface RepoFilesPanelProps {
  slug: string;
  canReadRepoFiles: boolean;
  labels: RepoFilesLabels;
}

export function RepoFilesPanel({
  slug,
  canReadRepoFiles,
  labels,
}: RepoFilesPanelProps): ReactElement {
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

  return (
    <section>
      <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
        {labels.title}
      </h2>
      <FileTree filesApiBase={`/api/projects/${slug}/files`} labels={labels} />
    </section>
  );
}
