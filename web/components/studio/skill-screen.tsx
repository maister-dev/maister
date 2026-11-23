"use client";

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { PackageFilesEditorLabels } from "@/components/flows/package-files-editor";
import type { ImportDialogLabels } from "@/components/studio/import-dialog";
import type { PackageFileNavigatorLabels } from "@/components/studio/package-file-navigator";
import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { ReactElement } from "react";

import Link from "next/link";
import { useState } from "react";

import { migrateLegacySkill } from "@/lib/local-packages/catalog-manifest";
import {
  PACKAGE_MANIFEST_FILENAME,
  parsePackageManifest,
} from "@/lib/local-packages/manifest";
import { PackageFileNavigator } from "@/components/studio/package-file-navigator";
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
  notFound: string;
  root: string;
  registerLegacy: string;
  migrationError: string;
  rename: { open: string; confirm: string; cancel: string };
};

// The dedicated skill screen (ADR-116 P4). Skills have nested folders, so its
// own subtree opens in the SAME PackageFileNavigator as the package Files tab
// (Finder/Tree switch, upload, create/rename/delete/move, content editor on the
// right) — scoped to the skill via `pathPrefix`. The navigator edits paths
// RELATIVE to the skill root; edits merge back into the full draft and persist
// through the shared working-dir save channel.

export function SkillScreen({
  packageId,
  sessionId,
  name,
  skillId,
  draftFiles,
  readOnly,
  dirty,
  labels,
  navigatorLabels,
  filesLabels,
  importLabels,
  mcpCatalog,
  onDraftFilesChange,
  onSave,
  onRename,
}: {
  packageId: string;
  sessionId?: string;
  name: string;
  skillId: string;
  draftFiles: AuthoredFlowPackageFile[];
  readOnly: boolean;
  dirty: boolean;
  labels: SkillScreenLabels;
  navigatorLabels: PackageFileNavigatorLabels;
  filesLabels: PackageFilesEditorLabels;
  importLabels: ImportDialogLabels;
  mcpCatalog: PlatformMcpCatalogEntry[];
  onDraftFilesChange: (next: AuthoredFlowPackageFile[]) => void;
  onSave: () => void;
  // Identity rename of the skill folder → localized error message, or null.
  onRename: (newName: string) => string | null;
}): ReactElement {
  const manifest = parsePackageManifest(
    draftFiles.find((f) => f.path === PACKAGE_MANIFEST_FILENAME)?.content ?? "",
  );
  const roots = manifest.ok
    ? manifest.model.capabilities.map((c) => c.path)
    : [];
  const [selectedRoot, setSelectedRoot] = useState("");
  const [migrationError, setMigrationError] = useState("");
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

  if (scoped.length === 0 || subtreePrefix === null) {
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

  // The navigator works rooted at the skill: strip the subtree prefix going in,
  // re-add it on every change before merging back into the full draft.
  const scopedRel = scoped.map((file) => ({
    ...file,
    path: file.path.slice(subtreePrefix.length),
  }));

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 rounded-xl border border-line bg-paper p-4"
      data-testid="skill-screen"
    >
      {breadcrumb}
      {!readOnly && subtreePrefix === "skills/" + skillId + "/" ? (
        <div className="flex items-center gap-2">
          {roots.length > 1 ? (
            <label>
              {labels.root}{" "}
              <select
                value={selectedRoot}
                onChange={(e) => setSelectedRoot(e.target.value)}
              >
                <option value="">{labels.root}</option>
                {roots.map((root) => (
                  <option key={root} value={root}>
                    {root}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            className="rounded-md border border-line px-2 py-1"
            disabled={roots.length > 1 && !selectedRoot}
            type="button"
            onClick={() => {
              try {
                onDraftFilesChange(
                  migrateLegacySkill(
                    draftFiles,
                    skillId,
                    selectedRoot || undefined,
                  ),
                );
                setMigrationError("");
              } catch (error) {
                setMigrationError(
                  error instanceof Error
                    ? error.message
                    : labels.migrationError,
                );
              }
            }}
          >
            {labels.registerLegacy}
          </button>
          {migrationError ? <span role="alert">{migrationError}</span> : null}
        </div>
      ) : null}
      {readOnly ? null : (
        <RenameControl
          currentName={skillId}
          labels={labels.rename}
          testidPrefix="skill-screen-rename"
          onSubmit={onRename}
        />
      )}
      <div className="min-h-0 flex-1">
        <PackageFileNavigator
          dirty={dirty}
          draftFiles={scopedRel}
          filesLabels={filesLabels}
          importLabels={importLabels}
          initialSelectedPath="SKILL.md"
          labels={navigatorLabels}
          mcpCatalog={mcpCatalog}
          packageId={packageId}
          pathPrefix={subtreePrefix.replace(/\/$/, "")}
          readOnly={readOnly}
          sessionId={sessionId}
          onDraftFilesChange={(nextRel) =>
            onDraftFilesChange(
              mergeSkillFiles(
                draftFiles,
                skillId,
                nextRel.map((file) => ({
                  ...file,
                  path: `${subtreePrefix}${file.path}`,
                })),
              ),
            )
          }
          onSaveDraft={onSave}
        />
      </div>
    </div>
  );
}
