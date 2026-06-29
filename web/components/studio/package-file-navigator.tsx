"use client";

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { PackageFilesEditorLabels } from "@/components/flows/package-files-editor";
import type { ImportDialogLabels } from "@/components/studio/import-dialog";
import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { ComponentPropsWithoutRef, ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  ContentEditor,
  uniqueNewPath,
} from "@/components/flows/package-files-editor";
import { ImportDialog } from "@/components/studio/import-dialog";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
import {
  removePackageFile,
  renamePackageFilePath,
  replacePackageFileContent,
  upsertPackageFile,
} from "@/lib/flows/editor/package-files-draft";
import {
  dirEntries,
  movePathInDraft,
  parentFolder,
  renameFolderInDraft,
} from "@/lib/local-packages/composition";

export type PackageFileNavigatorLabels = {
  viewFinder: string;
  viewTree: string;
  newFile: string;
  newFolder: string;
  newFolderName: string;
  upload: string;
  root: string;
  save: string;
  empty: string;
  selectHint: string;
  rename: string;
  remove: string;
  confirm: string;
  cancel: string;
  errorConflict: string;
  errorPrecondition: string;
};

type ViewMode = "finder" | "tree";

type RenameTarget = { path: string; isFolder: boolean; value: string };

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// An input that takes focus on mount (ref-based, per the project's focus
// convention — `autoFocus` is disallowed). Selects its contents when asked.
function FocusInput({
  selectOnMount,
  ...props
}: ComponentPropsWithoutRef<"input"> & {
  selectOnMount?: boolean;
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    if (selectOnMount) ref.current?.select();
  }, [selectOnMount]);

  return <input ref={ref} {...props} />;
}

// The unified file navigator for the local-package Files tab (ADR-116 follow-up).
// One surface — toggled between a Finder (one folder at a time, double-click to
// descend) and an expandable Tree — over the flat `draftFiles` model, with the
// selected file opening in the shared ContentEditor on the right. Folders are
// implied by paths; a freshly created empty folder is client-only (virtual) until
// a file lands in it, so it never needs a `.gitkeep` sentinel. All mutations go
// through the existing pure draft helpers and the one lock-guarded save channel.
export function PackageFileNavigator({
  packageId,
  sessionId,
  draftFiles,
  readOnly,
  dirty,
  labels,
  filesLabels,
  importLabels,
  mcpCatalog,
  pathPrefix = "",
  initialSelectedPath = null,
  onDraftFilesChange,
  onSaveDraft,
}: {
  packageId: string;
  sessionId?: string;
  draftFiles: AuthoredFlowPackageFile[];
  readOnly: boolean;
  // Whether the draft differs from the last-saved disk state (enables Save).
  dirty: boolean;
  labels: PackageFileNavigatorLabels;
  filesLabels: PackageFilesEditorLabels;
  importLabels: ImportDialogLabels;
  mcpCatalog: PlatformMcpCatalogEntry[];
  // When the navigator edits a SUBTREE (e.g. one skill), `draftFiles` carry paths
  // RELATIVE to this prefix; it is prepended to the upload target so files land in
  // the subtree on disk. Empty = the package root.
  pathPrefix?: string;
  initialSelectedPath?: string | null;
  onDraftFilesChange: (next: AuthoredFlowPackageFile[]) => void;
  onSaveDraft: () => void;
}): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const viewMode: ViewMode =
    searchParams.get("fileview") === "finder" ? "finder" : "tree";

  const [cwd, setCwd] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialSelectedPath,
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [virtualFolders, setVirtualFolders] = useState<string[]>([]);
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const selectedFile =
    draftFiles.find((file) => file.path === selectedPath) ?? null;

  function childFolders(folder: string): string[] {
    const prefix = folder ? `${folder}/` : "";
    const real = dirEntries(draftFiles, folder).folders;
    const virtual = virtualFolders
      .filter((v) => parentFolder(v) === folder)
      .map((v) => v.slice(prefix.length));

    return [...new Set([...real, ...virtual])].sort();
  }

  function setViewMode(mode: ViewMode): void {
    const params = new URLSearchParams(searchParams);

    params.set("fileview", mode);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function commit(next: AuthoredFlowPackageFile[]): void {
    setError(null);
    onDraftFilesChange(next);
  }

  function showError(code: "CONFLICT" | "PRECONDITION"): void {
    setError(
      code === "CONFLICT" ? labels.errorConflict : labels.errorPrecondition,
    );
  }

  function move(source: string, targetFolder: string): void {
    const result = movePathInDraft(draftFiles, source, targetFolder);

    if (!result.ok) {
      showError(result.code);

      return;
    }
    setVirtualFolders((prev) => prev.filter((v) => v !== targetFolder));
    commit(result.files);
  }

  function createFile(): void {
    const prefix = cwd ? `${cwd}/` : "";
    const path = uniqueNewPath(draftFiles, prefix);

    commit(upsertPackageFile(draftFiles, path, ""));
    setSelectedPath(path);
  }

  function submitNewFolder(): void {
    const name = (newFolderName ?? "").trim().replace(/\/+$/, "");

    if (!name || name.includes("/")) {
      showError("PRECONDITION");

      return;
    }
    const path = cwd ? `${cwd}/${name}` : name;

    setVirtualFolders((prev) => [...new Set([...prev, path])]);
    setNewFolderName(null);
    setError(null);
    if (viewMode === "finder") setCwd(path);
    else setExpanded((prev) => new Set(prev).add(cwd).add(path));
  }

  function submitRename(): void {
    if (!rename) return;
    const name = rename.value.trim();

    if (!name || name.includes("/")) {
      showError("PRECONDITION");

      return;
    }

    if (rename.isFolder) {
      const result = renameFolderInDraft(draftFiles, rename.path, name);

      if (!result.ok) {
        showError(result.code);

        return;
      }
      commit(result.files);
    } else {
      const dir = parentFolder(rename.path);
      const newPath = dir ? `${dir}/${name}` : name;

      if (
        newPath !== rename.path &&
        draftFiles.some((f) => f.path === newPath)
      ) {
        showError("CONFLICT");

        return;
      }
      commit(renamePackageFilePath(draftFiles, rename.path, newPath));
      if (selectedPath === rename.path) setSelectedPath(newPath);
    }
    setRename(null);
  }

  function deleteEntry(path: string, isFolder: boolean): void {
    if (isFolder) {
      const prefix = `${path}/`;

      commit(draftFiles.filter((f) => !f.path.startsWith(prefix)));
      setVirtualFolders((prev) =>
        prev.filter((v) => v !== path && !v.startsWith(prefix)),
      );
      if (selectedPath?.startsWith(prefix)) setSelectedPath(null);
    } else {
      commit(removePackageFile(draftFiles, path));
      if (selectedPath === path) setSelectedPath(null);
    }
  }

  const folders = childFolders(cwd);
  const files = dirEntries(draftFiles, cwd).files;
  const isEmpty = draftFiles.length === 0 && virtualFolders.length === 0;

  const rowActions = (path: string, isFolder: boolean): ReactElement | null =>
    readOnly ? null : (
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <button
          aria-label={labels.rename}
          className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-mute hover:border-amber hover:text-ink"
          data-testid="file-nav-rename"
          title={labels.rename}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setRename({ path, isFolder, value: basename(path) });
          }}
        >
          ✎
        </button>
        <button
          aria-label={labels.remove}
          className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-mute hover:border-danger hover:text-danger"
          data-testid="file-nav-remove"
          title={labels.remove}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            deleteEntry(path, isFolder);
          }}
        >
          ✕
        </button>
      </span>
    );

  const renameInput = (path: string): ReactElement => (
    <FocusInput
      selectOnMount
      aria-label={path}
      className="min-w-0 flex-1 rounded border border-amber bg-paper px-1.5 py-0.5 font-mono text-[12px] text-ink"
      data-testid="file-nav-rename-input"
      value={rename?.value ?? ""}
      onChange={(event) =>
        setRename((prev) =>
          prev ? { ...prev, value: event.target.value } : prev,
        )
      }
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitRename();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setRename(null);
        }
      }}
    />
  );

  function folderRow(folder: string, depth: number): ReactElement {
    const isRenaming = rename?.path === folder && rename.isFolder;
    const isExpanded = expanded.has(folder);

    return (
      <div
        key={`folder:${folder}`}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-ivory"
        data-folder={folder}
        data-testid="file-nav-folder"
        draggable={!readOnly && !isRenaming}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onDoubleClick={() => {
          if (viewMode === "finder") setCwd(folder);
        }}
        onDragEnd={() => setDragged(null)}
        onDragOver={(event) => event.preventDefault()}
        onDragStart={() => setDragged(folder)}
        onDrop={(event) => {
          event.preventDefault();
          if (dragged !== null && dragged !== folder) move(dragged, folder);
          setDragged(null);
        }}
      >
        {viewMode === "tree" ? (
          <button
            aria-label={folder}
            className="font-mono text-[11px] text-mute"
            data-testid="file-nav-folder-toggle"
            type="button"
            onClick={() =>
              setExpanded((prev) => {
                const next = new Set(prev);

                if (next.has(folder)) next.delete(folder);
                else next.add(folder);

                return next;
              })
            }
          >
            {isExpanded ? "▾" : "▸"}
          </button>
        ) : (
          <span aria-hidden className="font-mono text-[11px] text-mute">
            📁
          </span>
        )}
        {isRenaming ? (
          renameInput(folder)
        ) : (
          <button
            className="min-w-0 flex-1 truncate text-left font-mono text-[12px] font-semibold text-ink-2"
            type="button"
            onClick={() => {
              if (viewMode === "tree")
                setExpanded((prev) => {
                  const next = new Set(prev);

                  if (next.has(folder)) next.delete(folder);
                  else next.add(folder);

                  return next;
                });
              else setCwd(folder);
            }}
          >
            {basename(folder)}/
          </button>
        )}
        {isRenaming ? null : rowActions(folder, true)}
      </div>
    );
  }

  function fileRow(file: AuthoredFlowPackageFile, depth: number): ReactElement {
    const isRenaming = rename?.path === file.path && !rename.isFolder;

    return (
      <div
        key={`file:${file.path}`}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 ${
          selectedPath === file.path ? "bg-amber-soft" : "hover:bg-ivory"
        }`}
        data-path={file.path}
        data-testid="file-nav-file"
        draggable={!readOnly && !isRenaming}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onDragEnd={() => setDragged(null)}
        onDragStart={() => setDragged(file.path)}
      >
        <span aria-hidden className="font-mono text-[11px] text-mute">
          ▪
        </span>
        {isRenaming ? (
          renameInput(file.path)
        ) : (
          <button
            className={`min-w-0 flex-1 truncate text-left font-mono text-[12px] ${
              selectedPath === file.path ? "text-amber" : "text-ink"
            }`}
            type="button"
            onClick={() => setSelectedPath(file.path)}
          >
            {basename(file.path)}
          </button>
        )}
        {isRenaming ? null : rowActions(file.path, false)}
      </div>
    );
  }

  function treeLevel(folder: string, depth: number): ReactElement[] {
    const rows: ReactElement[] = [];

    for (const sub of childFolders(folder)) {
      const subPath = folder ? `${folder}/${sub}` : sub;

      rows.push(folderRow(subPath, depth));
      if (expanded.has(subPath)) rows.push(...treeLevel(subPath, depth + 1));
    }
    for (const file of dirEntries(draftFiles, folder).files) {
      rows.push(fileRow(file, depth));
    }

    return rows;
  }

  // Save persists the whole draft to disk; enabled only when it differs from the
  // last-saved state. Rendered at both the top and bottom of the editor pane so a
  // long file does not force a scroll to reach it.
  const saveButton = (testid: string): ReactElement => (
    <button
      className="shrink-0 justify-self-start rounded-md border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white hover:bg-amber-2 disabled:cursor-not-allowed disabled:border-line disabled:bg-ivory disabled:text-mute"
      data-testid={testid}
      disabled={!dirty}
      type="button"
      onClick={onSaveDraft}
    >
      {labels.save}
    </button>
  );

  const crumbs = cwd ? cwd.split("/") : [];

  return (
    <>
      <div
        className="grid min-h-0 gap-3 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]"
        data-testid="file-navigator"
      >
        <div className="flex min-h-0 flex-col gap-2 rounded-[12px] border border-line bg-ivory p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex overflow-hidden rounded-md border border-line">
              <button
                aria-pressed={viewMode === "tree"}
                className={`px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] ${
                  viewMode === "tree"
                    ? "bg-amber text-white"
                    : "bg-paper text-mute hover:text-ink"
                }`}
                data-testid="file-nav-view-tree"
                type="button"
                onClick={() => setViewMode("tree")}
              >
                {labels.viewTree}
              </button>
              <button
                aria-pressed={viewMode === "finder"}
                className={`px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] ${
                  viewMode === "finder"
                    ? "bg-amber text-white"
                    : "bg-paper text-mute hover:text-ink"
                }`}
                data-testid="file-nav-view-finder"
                type="button"
                onClick={() => setViewMode("finder")}
              >
                {labels.viewFinder}
              </button>
            </div>
            {readOnly ? null : (
              <>
                <button
                  className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:border-amber"
                  data-testid="file-nav-new-file"
                  type="button"
                  onClick={createFile}
                >
                  + {labels.newFile}
                </button>
                <button
                  className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:border-amber"
                  data-testid="file-nav-new-folder"
                  type="button"
                  onClick={() => setNewFolderName("")}
                >
                  + {labels.newFolder}
                </button>
                <button
                  className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-ink-2 hover:border-amber"
                  data-testid="file-nav-upload"
                  title={cwd ? `${labels.upload}: ${cwd}` : labels.upload}
                  type="button"
                  onClick={() => setImportOpen(true)}
                >
                  ⤓ {labels.upload}
                </button>
              </>
            )}
          </div>

          {viewMode === "finder" ? (
            <nav
              aria-label="breadcrumb"
              className="flex flex-wrap items-center gap-1 font-mono text-[10.5px] text-mute"
              data-testid="file-nav-breadcrumb"
            >
              <button
                className="hover:text-ink"
                data-folder=""
                data-testid="file-nav-crumb"
                type="button"
                onClick={() => setCwd("")}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragged !== null) move(dragged, "");
                  setDragged(null);
                }}
              >
                {labels.root}
              </button>
              {crumbs.map((seg, index) => {
                const folder = crumbs.slice(0, index + 1).join("/");

                return (
                  <span key={folder} className="flex items-center gap-1">
                    <span aria-hidden>/</span>
                    <button
                      className="hover:text-ink"
                      data-folder={folder}
                      data-testid="file-nav-crumb"
                      type="button"
                      onClick={() => setCwd(folder)}
                    >
                      {seg}
                    </button>
                  </span>
                );
              })}
            </nav>
          ) : null}

          {newFolderName !== null ? (
            <div className="flex items-center gap-1.5">
              <FocusInput
                className="min-w-0 flex-1 rounded border border-amber bg-paper px-1.5 py-0.5 font-mono text-[11px] text-ink"
                data-testid="file-nav-new-folder-input"
                placeholder={labels.newFolderName}
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitNewFolder();
                  } else if (event.key === "Escape") {
                    setNewFolderName(null);
                  }
                }}
              />
              <button
                className="rounded border border-amber bg-amber px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-white"
                data-testid="file-nav-new-folder-confirm"
                type="button"
                onClick={submitNewFolder}
              >
                {labels.confirm}
              </button>
            </div>
          ) : null}

          <div
            className="min-h-0 flex-1 overflow-auto"
            data-testid="file-nav-list"
          >
            {isEmpty ? (
              <p className="m-0 px-2 py-2 font-mono text-[11px] text-mute">
                {labels.empty}
              </p>
            ) : viewMode === "finder" ? (
              <>
                {folders.map((sub) =>
                  folderRow(cwd ? `${cwd}/${sub}` : sub, 0),
                )}
                {files.map((file) => fileRow(file, 0))}
              </>
            ) : (
              treeLevel("", 0)
            )}
          </div>

          {error ? (
            <span
              className="font-mono text-[10.5px] text-danger"
              data-testid="file-nav-error"
              role="alert"
            >
              {error}
            </span>
          ) : null}
        </div>

        <div className="min-h-0 rounded-[12px] border border-line bg-ivory p-3">
          {selectedFile ? (
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate font-mono text-[11px] text-mute">
                  {selectedFile.path}
                </div>
                {readOnly ? null : saveButton("file-nav-save-top")}
              </div>
              <ContentEditor
                key={selectedFile.path}
                disabled={readOnly}
                file={selectedFile}
                inferredKind={classifyPackageFilePath(selectedFile.path)}
                labels={filesLabels}
                mcpCatalog={mcpCatalog}
                onChangeContent={(next) =>
                  commit(
                    replacePackageFileContent(
                      draftFiles,
                      selectedFile.path,
                      next,
                    ),
                  )
                }
              />
              {readOnly ? null : saveButton("file-nav-save")}
            </div>
          ) : (
            <p
              className="m-0 font-mono text-[11px] text-mute"
              data-testid="file-nav-select-hint"
            >
              {labels.selectHint}
            </p>
          )}
        </div>
      </div>
      {importOpen ? (
        <ImportDialog
          labels={importLabels}
          packageId={packageId}
          sessionId={sessionId}
          targetFolder={[pathPrefix, cwd].filter(Boolean).join("/")}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
    </>
  );
}
