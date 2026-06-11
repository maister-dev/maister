"use client";

import type {
  AuthoredFlowPackageFile,
  AuthoredFlowPackageFileKind,
} from "@/lib/catalog/authored-types";
import type {
  FileTreeNode,
  PathEditValidation,
} from "@/lib/flows/editor/package-file-tree";
import type { ReactElement, ReactNode } from "react";

import { useEffect, useMemo, useRef, useState } from "react";

import { CodeEditor } from "./code-editor";

import {
  type FrontmatterArtifactEditorLabels,
  FrontmatterArtifactEditor,
} from "@/components/flows/artifact-editors/frontmatter-artifact-editor";
import {
  type ScriptArtifactEditorLabels,
  ScriptArtifactEditor,
} from "@/components/flows/artifact-editors/script-artifact-editor";
import {
  type FormSchemaBuilderLabels,
  FormSchemaBuilder,
} from "@/components/flows/artifact-editors/form-schema-builder";
import {
  type ArtifactContentIssuesLabels,
  ArtifactContentIssues,
} from "@/components/flows/editor-validation-summary";
import { validateArtifactContent } from "@/lib/flows/artifact-validate";
import {
  buildFileTree,
  classifyPackageFilePath,
  validatePathEdit,
} from "@/lib/flows/editor/package-file-tree";

type PathErrorCode = "unsafe_path" | "duplicate_path" | "path_conflict";

export type PackageFilesEditorLabels = {
  addFile: string;
  cancel: string;
  content: string;
  editPathTitle: string;
  kind: string;
  noFiles: string;
  path: string;
  pathError: Record<PathErrorCode, string>;
  removeFile: string;
  renamePath: string;
  save: string;
  frontmatter: FrontmatterArtifactEditorLabels;
  script: ScriptArtifactEditorLabels;
  formSchema: FormSchemaBuilderLabels;
  contentIssues: ArtifactContentIssuesLabels;
};

export function PackageFilesEditor({
  disabled,
  files,
  kindLabels,
  labels,
  manifest = null,
}: {
  disabled: boolean;
  files: AuthoredFlowPackageFile[];
  kindLabels: Record<AuthoredFlowPackageFileKind, string>;
  labels: PackageFilesEditorLabels;
  manifest?: Record<string, unknown> | null;
}): ReactElement {
  const [draftFiles, setDraftFiles] = useState(files);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    files[0]?.path ?? null,
  );
  const [editPath, setEditPath] = useState<string | null>(null);

  const serialized = useMemo(() => JSON.stringify(draftFiles), [draftFiles]);
  const tree = useMemo(() => buildFileTree(draftFiles), [draftFiles]);
  const contentIssues = useMemo(
    () => validateArtifactContent({ files: draftFiles, manifest }),
    [draftFiles, manifest],
  );
  const selectedFile = useMemo(
    () => draftFiles.find((file) => file.path === selectedPath) ?? null,
    [draftFiles, selectedPath],
  );

  function applyPathEdit(oldPath: string, newPath: string): void {
    setDraftFiles((current) =>
      current.map((file) =>
        file.path === oldPath
          ? { ...file, path: newPath, kind: classifyPackageFilePath(newPath) }
          : file,
      ),
    );
    setSelectedPath(newPath);
    setEditPath(null);
  }

  function addFile(): void {
    const folder = selectedFile
      ? selectedFile.path.slice(0, selectedFile.path.lastIndexOf("/") + 1)
      : "";
    const newPath = uniqueNewPath(draftFiles, folder);

    setDraftFiles((current) => [
      ...current,
      { kind: classifyPackageFilePath(newPath), path: newPath, content: "" },
    ]);
    setSelectedPath(newPath);
  }

  function removeFile(targetPath: string): void {
    setDraftFiles((current) => {
      const next = current.filter((file) => file.path !== targetPath);

      if (selectedPath === targetPath) {
        setSelectedPath(next[0]?.path ?? null);
      }

      return next;
    });
  }

  return (
    <div className="mt-4 grid gap-3">
      <input name="packageFilesJson" type="hidden" value={serialized} />

      {draftFiles.length === 0 ? (
        <p className="m-0 rounded-lg border border-line bg-ivory px-3 py-3 text-[12px] text-mute">
          {labels.noFiles}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)]">
          <div className="rounded-lg border border-line bg-ivory p-2">
            <ul className="m-0 grid list-none gap-0.5 p-0">
              <FileTreeNodes
                depth={0}
                nodes={tree}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
              />
            </ul>
          </div>

          <div className="rounded-lg border border-line bg-ivory p-3">
            {selectedFile ? (
              <SelectedFileEditor
                disabled={disabled}
                file={selectedFile}
                kindLabels={kindLabels}
                labels={labels}
                onChangeContent={(next) =>
                  setDraftFiles((current) =>
                    current.map((file) =>
                      file.path === selectedFile.path
                        ? { ...file, content: next }
                        : file,
                    ),
                  )
                }
                onRemove={() => removeFile(selectedFile.path)}
                onRename={() => setEditPath(selectedFile.path)}
              />
            ) : null}
          </div>
        </div>
      )}

      {draftFiles.length === 0 ? null : (
        <ArtifactContentIssues
          issues={contentIssues}
          labels={labels.contentIssues}
        />
      )}

      {disabled ? null : (
        <button
          className="justify-self-start rounded-md border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-amber hover:bg-paper"
          type="button"
          onClick={addFile}
        >
          {labels.addFile}
        </button>
      )}

      {editPath !== null ? (
        <PathEditDialog
          files={draftFiles}
          initialPath={editPath}
          labels={labels}
          onApply={(next) => applyPathEdit(editPath, next)}
          onClose={() => setEditPath(null)}
        />
      ) : null}
    </div>
  );
}

function FileTreeNodes({
  nodes,
  depth,
  selectedPath,
  onSelect,
}: {
  nodes: FileTreeNode[];
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}): ReactElement {
  return (
    <>
      {nodes.map((node) =>
        node.type === "folder" ? (
          <li key={`folder:${node.path}`}>
            <span
              className="block truncate px-2 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-mute"
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              {node.name}/
            </span>
            <ul className="m-0 grid list-none gap-0.5 p-0">
              <FileTreeNodes
                depth={depth + 1}
                nodes={node.children}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            </ul>
          </li>
        ) : (
          <li key={`file:${node.path}`}>
            <button
              className={`block w-full truncate rounded-md px-2 py-1 text-left font-mono text-[12px] ${
                selectedPath === node.path
                  ? "bg-amber-soft text-amber"
                  : "text-ink hover:bg-paper"
              }`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              type="button"
              onClick={() => onSelect(node.path)}
            >
              {node.name}
            </button>
          </li>
        ),
      )}
    </>
  );
}

function SelectedFileEditor({
  disabled,
  file,
  kindLabels,
  labels,
  onChangeContent,
  onRemove,
  onRename,
}: {
  disabled: boolean;
  file: AuthoredFlowPackageFile;
  kindLabels: Record<AuthoredFlowPackageFileKind, string>;
  labels: PackageFilesEditorLabels;
  onChangeContent: (next: string) => void;
  onRemove: () => void;
  onRename: () => void;
}): ReactElement {
  const inferredKind = classifyPackageFilePath(file.path);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[12px] text-ink">
            {file.path}
          </span>
          <span
            className="shrink-0 rounded-md border border-line bg-paper px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-mute"
            title={labels.kind}
          >
            {kindLabels[inferredKind]}
          </span>
        </div>

        {disabled ? null : (
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="h-[30px] rounded-md border border-line px-3 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-2 hover:bg-paper"
              type="button"
              onClick={onRename}
            >
              {labels.renamePath}
            </button>
            <button
              className="h-[30px] rounded-md border border-line px-3 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-2 hover:bg-paper"
              type="button"
              onClick={onRemove}
            >
              {labels.removeFile}
            </button>
          </div>
        )}
      </div>

      <div className="grid gap-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
          {labels.content}
        </span>
        <ContentEditor
          key={file.path}
          disabled={disabled}
          file={file}
          inferredKind={inferredKind}
          labels={labels}
          onChangeContent={onChangeContent}
        />
      </div>
    </div>
  );
}

function ContentEditor({
  disabled,
  file,
  inferredKind,
  labels,
  onChangeContent,
}: {
  disabled: boolean;
  file: AuthoredFlowPackageFile;
  inferredKind: AuthoredFlowPackageFileKind;
  labels: PackageFilesEditorLabels;
  onChangeContent: (next: string) => void;
}): ReactElement {
  if (
    inferredKind === "skill" ||
    inferredKind === "agent_definition" ||
    inferredKind === "rule"
  ) {
    return (
      <FrontmatterArtifactEditor
        content={file.content}
        kind={inferredKind}
        labels={labels.frontmatter}
        readOnly={disabled}
        onChange={onChangeContent}
      />
    );
  }

  if (inferredKind === "script" || inferredKind === "setup") {
    return (
      <ScriptArtifactEditor
        content={file.content}
        labels={labels.script}
        readOnly={disabled}
        onChange={onChangeContent}
      />
    );
  }

  if (inferredKind === "schema") {
    return (
      <FormSchemaBuilder
        content={file.content}
        labels={labels.formSchema}
        readOnly={disabled}
        onChange={onChangeContent}
      />
    );
  }

  return (
    <CodeEditor
      ariaLabel={`${labels.content}: ${file.path}`}
      kind={inferredKind}
      readOnly={disabled}
      value={file.content}
      onChange={onChangeContent}
    />
  );
}

function PathEditDialog({
  files,
  initialPath,
  labels,
  onApply,
  onClose,
}: {
  files: AuthoredFlowPackageFile[];
  initialPath: string;
  labels: PackageFilesEditorLabels;
  onApply: (nextPath: string) => void;
  onClose: () => void;
}): ReactElement {
  const [pathDraft, setPathDraft] = useState(initialPath);
  const validation: PathEditValidation = useMemo(
    () => validatePathEdit(files, initialPath, pathDraft),
    [files, initialPath, pathDraft],
  );

  function submit(): void {
    if (validation.ok) onApply(validation.path);
  }

  return (
    <DialogShell
      cancel={labels.cancel}
      footer={
        <>
          <button
            className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
            type="button"
            onClick={onClose}
          >
            {labels.cancel}
          </button>
          <button
            className="rounded-md border border-amber bg-amber px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
            disabled={!validation.ok}
            type="button"
            onClick={submit}
          >
            {labels.save}
          </button>
        </>
      }
      title={labels.editPathTitle}
      onClose={onClose}
    >
      <label className="grid gap-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
          {labels.path}
        </span>
        <input
          className="rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        {validation.ok ? null : (
          <span
            aria-live="assertive"
            className="font-mono text-[10px] font-semibold text-amber"
            role="alert"
          >
            {labels.pathError[validation.code]}
          </span>
        )}
      </label>
    </DialogShell>
  );
}

function DialogShell({
  title,
  cancel,
  children,
  footer,
  onClose,
}: {
  title: string;
  cancel: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];

    focusable()[0]?.focus();

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();

        return;
      }

      if (event.key !== "Tab") return;

      const items = focusable();

      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
      <button
        aria-label={cancel}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.48)] backdrop-blur-sm"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby="package-file-path-dialog-title"
        aria-modal="true"
        className="relative z-10 flex max-h-[86vh] w-full max-w-[520px] flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-2xl"
        role="dialog"
      >
        <div className="border-b border-line px-4 py-3">
          <h2
            className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-ink"
            id="package-file-path-dialog-title"
          >
            {title}
          </h2>
        </div>
        <div className="flex-1 overflow-auto px-4 py-4">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

function uniqueNewPath(
  files: readonly AuthoredFlowPackageFile[],
  folder: string,
): string {
  const taken = new Set(files.map((file) => file.path));

  for (let index = 0; ; index += 1) {
    const candidate = `${folder}new-file${index === 0 ? "" : `-${index}`}.md`;

    if (!taken.has(candidate)) return candidate;
  }
}
