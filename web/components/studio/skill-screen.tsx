"use client";

import type {
  AuthoredFlowPackageFile,
  AuthoredFlowPackageFileKind,
} from "@/lib/catalog/authored-types";
import type { PackageFilesEditorLabels } from "@/components/flows/package-files-editor";
import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { ReactElement } from "react";

import Link from "next/link";

import { PackageFilesEditor } from "@/components/flows/package-files-editor";
import { RenameControl } from "@/components/studio/package-composition";
import {
  compositionTabHref,
  mergeSkillFiles,
  resolveSkillSubtreePrefix,
  scopeSkillFiles,
} from "@/lib/local-packages/composition";

export type SkillScreenLabels = {
  crumbStudio: string;
  crumbLocal: string;
  crumbSkills: string;
  save: string;
  notFound: string;
  rename: { open: string; confirm: string; cancel: string };
};

// The dedicated skill screen (ADR-116 P4): a PackageFilesEditor scoped to the
// `skills/<id>/` subtree (skills have nested folders, which a side panel cannot
// hold) + a breadcrumb back to the composition Skills tab. SKILL.md opens in the
// FrontmatterArtifactEditor (the editor dispatches by path). Edits merge back into
// the full draft and persist through the same working-dir save channel.
export function SkillScreen({
  packageId,
  name,
  skillId,
  draftFiles,
  readOnly,
  labels,
  filesLabels,
  fileKindLabels,
  mcpCatalog,
  onDraftFilesChange,
  onSave,
  onRename,
}: {
  packageId: string;
  name: string;
  skillId: string;
  draftFiles: AuthoredFlowPackageFile[];
  readOnly: boolean;
  labels: SkillScreenLabels;
  filesLabels: PackageFilesEditorLabels;
  fileKindLabels: Record<AuthoredFlowPackageFileKind, string>;
  mcpCatalog: PlatformMcpCatalogEntry[];
  onDraftFilesChange: (next: AuthoredFlowPackageFile[]) => void;
  onSave: () => void;
  // Identity rename of the skill folder → localized error message, or null.
  onRename: (newName: string) => string | null;
}): ReactElement {
  const subtreePrefix = resolveSkillSubtreePrefix(draftFiles, skillId);
  const scoped = scopeSkillFiles(draftFiles, skillId);

  const breadcrumb = (
    <nav
      aria-label="breadcrumb"
      className="flex min-w-0 shrink-0 items-center gap-1.5 font-mono text-[11px] text-mute"
    >
      <Link className="hover:text-ink" href="/studio">
        {labels.crumbStudio}
      </Link>
      <span aria-hidden>›</span>
      <Link className="hover:text-ink" href="/studio/local">
        {labels.crumbLocal}
      </Link>
      <span aria-hidden>›</span>
      <span className="truncate text-ink-2">{name}</span>
      <span aria-hidden>›</span>
      <Link
        className="hover:text-ink"
        data-testid="skill-screen-back"
        href={compositionTabHref(packageId, "skills")}
      >
        {labels.crumbSkills}
      </Link>
      <span aria-hidden>›</span>
      <span className="truncate text-ink" data-testid="skill-screen-id">
        {skillId}
      </span>
    </nav>
  );

  if (scoped.length === 0) {
    return (
      <div
        className="flex h-full min-h-0 flex-col gap-3 rounded-xl border border-line bg-paper p-4"
        data-testid="skill-screen"
      >
        {breadcrumb}
        <p
          className="m-0 font-mono text-[11px] text-mute"
          data-testid="skill-screen-not-found"
        >
          {labels.notFound}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 rounded-xl border border-line bg-paper p-4"
      data-testid="skill-screen"
    >
      {breadcrumb}
      {readOnly ? null : (
        <RenameControl
          currentName={skillId}
          labels={labels.rename}
          testidPrefix="skill-screen-rename"
          onSubmit={onRename}
        />
      )}
      <div className="grid min-h-0 flex-1 gap-3">
        <PackageFilesEditor
          disabled={readOnly}
          files={scoped}
          initialSelectedPath={`${subtreePrefix ?? `skills/${skillId}/`}SKILL.md`}
          kindLabels={fileKindLabels}
          labels={filesLabels}
          mcpCatalog={mcpCatalog}
          onFilesChange={(next) =>
            onDraftFilesChange(mergeSkillFiles(draftFiles, skillId, next))
          }
        />
        {readOnly ? null : (
          <button
            className="justify-self-start rounded-md border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white hover:bg-amber-2"
            data-testid="skill-screen-save"
            type="button"
            onClick={onSave}
          >
            {labels.save}
          </button>
        )}
      </div>
    </div>
  );
}
