"use client";

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { ReactElement } from "react";

import { useMemo, useRef, useState } from "react";

import {
  folderPathsOf,
  movePathInDraft,
} from "@/lib/local-packages/composition";

export type FilesManagerLabels = {
  moveTitle: string;
  moveHint: string;
  root: string;
  newFolder: string;
  add: string;
  errorConflict: string;
  errorPrecondition: string;
};

// The Files-tab move + virtual-folder layer (ADR-115 P7, D7). The raw tree +
// content editing + new file + rename + delete live in the sibling
// PackageFilesEditor; this adds: a breadcrumb of the picked source, drag-and-drop
// (or click) move of a file/folder into a destination folder, and client-only
// "new folder" targets that materialize only when a file lands in them (no
// `.gitkeep` sentinel). All gated by `readOnly`.
export function FilesManager({
  draftFiles,
  readOnly,
  labels,
  onDraftFilesChange,
}: {
  draftFiles: AuthoredFlowPackageFile[];
  readOnly: boolean;
  labels: FilesManagerLabels;
  onDraftFilesChange: (next: AuthoredFlowPackageFile[]) => void;
}): ReactElement {
  const [virtualFolders, setVirtualFolders] = useState<string[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);

  const folders = useMemo(() => {
    const all = new Set<string>(["", ...folderPathsOf(draftFiles)]);

    for (const v of virtualFolders) all.add(v);

    return [...all].sort();
  }, [draftFiles, virtualFolders]);

  const move = (sourcePath: string, target: string): void => {
    const result = movePathInDraft(draftFiles, sourcePath, target);

    if (!result.ok) {
      setError(
        result.code === "CONFLICT"
          ? labels.errorConflict
          : labels.errorPrecondition,
      );

      return;
    }
    setError(null);
    setSource(null);
    // A virtual folder that just received a file is now real — drop it from the
    // client-only set (it materializes from the moved path; no sentinel).
    setVirtualFolders((prev) => prev.filter((v) => v !== target));
    onDraftFilesChange(result.files);
  };

  const breadcrumb = source ? source.split("/") : [];

  return (
    <div
      className="flex flex-col gap-2 rounded-[12px] border border-line bg-ivory px-3 py-2.5"
      data-testid="files-manager"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-mute">
          {labels.moveTitle}
        </span>
        <span className="font-mono text-[10.5px] text-mute">
          {labels.moveHint}
        </span>
      </div>

      <nav
        aria-label="breadcrumb"
        className="flex flex-wrap items-center gap-1 font-mono text-[10.5px] text-mute"
        data-testid="files-manager-breadcrumb"
      >
        <span>{labels.root}</span>
        {breadcrumb.map((seg, index) => (
          <span key={`${seg}-${index}`}>
            <span aria-hidden> / </span>
            {seg}
          </span>
        ))}
      </nav>

      {readOnly ? null : (
        <>
          <div
            className="flex flex-wrap gap-1.5"
            data-testid="files-manager-sources"
          >
            {draftFiles.map((file) => (
              <button
                key={file.path}
                draggable
                aria-pressed={source === file.path}
                className={
                  source === file.path
                    ? "rounded-md border border-amber bg-amber-soft px-2 py-0.5 font-mono text-[10.5px] text-amber"
                    : "rounded-md border border-line bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-2 hover:border-amber"
                }
                data-testid="files-manager-source"
                type="button"
                onClick={() => setSource(file.path)}
                onDragStart={() => {
                  dragged.current = file.path;
                }}
              >
                {file.path}
              </button>
            ))}
          </div>

          <div
            className="flex flex-wrap gap-1.5"
            data-testid="files-manager-targets"
          >
            {folders.map((folder) => (
              <button
                key={folder || "(root)"}
                className="rounded-md border border-dashed border-line bg-paper px-2 py-0.5 font-mono text-[10.5px] text-ink-2 hover:border-amber"
                data-folder={folder}
                data-testid="files-manager-target"
                disabled={source === null && dragged.current === null}
                type="button"
                onClick={() => {
                  if (source !== null) move(source, folder);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragged.current !== null) {
                    move(dragged.current, folder);
                    dragged.current = null;
                  }
                }}
              >
                {folder === "" ? labels.root : folder}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <input
              aria-label={labels.newFolder}
              className="min-h-[28px] rounded-md border border-line bg-paper px-2 font-mono text-[10.5px] text-ink"
              data-testid="files-manager-new-folder"
              placeholder={labels.newFolder}
              value={newFolder}
              onChange={(event) => setNewFolder(event.target.value)}
            />
            <button
              className="min-h-[28px] rounded-md border border-line px-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-2 hover:border-amber"
              data-testid="files-manager-add-folder"
              disabled={newFolder.trim() === ""}
              type="button"
              onClick={() => {
                const name = newFolder.trim().replace(/\/+$/, "");

                if (name)
                  setVirtualFolders((prev) => [...new Set([...prev, name])]);
                setNewFolder("");
              }}
            >
              {labels.add}
            </button>
          </div>

          {error ? (
            <span
              className="font-mono text-[10.5px] text-danger"
              data-testid="files-manager-error"
              role="alert"
            >
              {error}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
