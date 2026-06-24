import type {
  PackageFileReadState,
  PackageFileViewLabels,
} from "@/components/flows/package-viewer";
import type { ReactElement, ReactNode } from "react";

import Link from "next/link";

import { PackageFileView } from "@/components/flows/package-viewer";

export interface SkillBundleFile {
  // Path RELATIVE to the skill bundle root (e.g. `SKILL.md`, `references/x.md`).
  relPath: string;
  kind: string;
}

export interface SkillBundleViewLabels {
  filesTitle: string;
  frontmatterTitle: string;
  noFrontmatter: string;
  bundleMissing: string;
  empty: string;
  file: PackageFileViewLabels;
}

export interface SkillBundleViewProps {
  skillId: string;
  files: SkillBundleFile[];
  // The SKILL.md frontmatter `name`/`description` (parsed server-side), or null.
  frontmatter: { name?: string; description?: string } | null;
  selectedRelPath: string | null;
  selectedFile: PackageFileReadState | null;
  documentView?: ReactNode;
  // The read-only editor host for the selected `text` file (rich CodeMirror is
  // client-only); the page passes it so this stays a server component.
  editor?: ReactNode;
  bundleMissing: boolean;
  labels: SkillBundleViewLabels;
  // Builds the file-select href (deep-linkable `?file=`), bundle-relative path in.
  hrefFor: (relPath: string) => string;
}

// Master–detail skill bundle browser (M36 T1.5). Pure presentational server
// component: the page resolves the file list + selected-file read state +
// frontmatter (all confined disk reads) and passes them here. No disk handle
// crosses into these props.
export function SkillBundleView({
  files,
  frontmatter,
  selectedRelPath,
  selectedFile,
  documentView,
  editor,
  bundleMissing,
  labels,
  hrefFor,
}: SkillBundleViewProps): ReactElement {
  if (bundleMissing) {
    return (
      <div
        className="rounded-lg border border-dashed border-amber-line bg-amber-soft px-4 py-6 text-center font-mono text-[12px] text-amber"
        data-testid="skill-bundle-missing"
      >
        {labels.bundleMissing}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section
        className="rounded-[14px] border border-line bg-paper px-5 py-4"
        data-testid="skill-frontmatter"
      >
        <h2 className="m-0 mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
          {labels.frontmatterTitle}
        </h2>
        {frontmatter ? (
          <>
            {frontmatter.name ? (
              <div className="text-[15px] font-semibold text-ink">
                {frontmatter.name}
              </div>
            ) : null}
            {frontmatter.description ? (
              <p className="mt-1 text-[13px] leading-[1.5] text-ink-2">
                {frontmatter.description}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[12.5px] text-mute">{labels.noFrontmatter}</p>
        )}
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <section>
          <h2 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
            {labels.filesTitle}
          </h2>
          {files.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line bg-paper px-3 py-5 text-center font-mono text-[11px] text-mute">
              {labels.empty}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="skill-file-list">
              {files.map((file) => {
                const isSelected = file.relPath === selectedRelPath;

                return (
                  <li key={file.relPath}>
                    <Link
                      aria-current={isSelected ? "true" : undefined}
                      className={
                        isSelected
                          ? "flex items-center justify-between gap-2 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] text-ink"
                          : "flex items-center justify-between gap-2 rounded-lg border border-line-soft bg-ivory px-3 py-2 font-mono text-[11px] text-ink-2 hover:border-line"
                      }
                      href={hrefFor(file.relPath)}
                    >
                      <span className="truncate">{file.relPath}</span>
                      <span className="shrink-0 rounded-full border border-line bg-paper px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-mute">
                        {file.kind}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="min-w-0">
          {documentView ?? (
            <PackageFileView
              editor={editor}
              labels={labels.file}
              relPath={selectedRelPath}
              state={selectedFile}
            />
          )}
        </section>
      </div>
    </div>
  );
}
