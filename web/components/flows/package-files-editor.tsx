"use client";

import type {
  AuthoredFlowPackageFile,
  AuthoredFlowPackageFileKind,
} from "@/lib/catalog/authored-types";
import type { Dispatch, ReactElement, SetStateAction } from "react";

import { useMemo, useState } from "react";

const PACKAGE_FILE_KINDS: readonly AuthoredFlowPackageFileKind[] = [
  "asset",
  "skill",
  "rule",
  "script",
  "agent_definition",
  "schema",
  "template",
  "readme",
  "setup",
];

export type PackageFilesEditorLabels = {
  addFile: string;
  content: string;
  kind: string;
  path: string;
  removeFile: string;
};

export function PackageFilesEditor({
  disabled,
  files,
  kindLabels,
  labels,
}: {
  disabled: boolean;
  files: AuthoredFlowPackageFile[];
  kindLabels: Record<AuthoredFlowPackageFileKind, string>;
  labels: PackageFilesEditorLabels;
}): ReactElement {
  const [draftFiles, setDraftFiles] = useState(files);
  const serialized = useMemo(() => JSON.stringify(draftFiles), [draftFiles]);

  return (
    <div className="mt-4 grid gap-3">
      <input name="packageFilesJson" type="hidden" value={serialized} />
      {draftFiles.map((file, index) => (
        <div
          key={`${index}:${file.path}`}
          className="rounded-lg border border-line bg-ivory p-3"
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto]">
            <label className="grid gap-1.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                {labels.kind}
              </span>
              <select
                className="rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-70"
                disabled={disabled}
                value={file.kind}
                onChange={(event) => {
                  updateFile(setDraftFiles, index, {
                    ...file,
                    kind: event.target.value as AuthoredFlowPackageFileKind,
                  });
                }}
              >
                {PACKAGE_FILE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabels[kind]}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
                {labels.path}
              </span>
              <input
                className="rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber disabled:opacity-70"
                disabled={disabled}
                value={file.path}
                onChange={(event) => {
                  updateFile(setDraftFiles, index, {
                    ...file,
                    path: event.target.value,
                  });
                }}
              />
            </label>

            {disabled ? null : (
              <div className="flex items-end">
                <button
                  className="h-[34px] rounded-md border border-line px-3 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ink-2 hover:bg-paper"
                  type="button"
                  onClick={() => {
                    setDraftFiles((current) =>
                      current.filter((_, fileIndex) => fileIndex !== index),
                    );
                  }}
                >
                  {labels.removeFile}
                </button>
              </div>
            )}
          </div>

          <label className="mt-3 grid gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
              {labels.content}
            </span>
            <textarea
              className="min-h-[150px] resize-y rounded-md border border-line bg-paper px-3 py-2 font-mono text-[12px] leading-[1.5] text-ink outline-none focus:border-amber disabled:opacity-70"
              disabled={disabled}
              spellCheck={false}
              value={file.content}
              onChange={(event) => {
                updateFile(setDraftFiles, index, {
                  ...file,
                  content: event.target.value,
                });
              }}
            />
          </label>
        </div>
      ))}

      {disabled ? null : (
        <button
          className="justify-self-start rounded-md border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-amber hover:bg-paper"
          type="button"
          onClick={() => {
            setDraftFiles((current) => [
              ...current,
              { kind: "asset", path: "", content: "" },
            ]);
          }}
        >
          {labels.addFile}
        </button>
      )}
    </div>
  );
}

function updateFile(
  setDraftFiles: Dispatch<SetStateAction<AuthoredFlowPackageFile[]>>,
  index: number,
  file: AuthoredFlowPackageFile,
): void {
  setDraftFiles((current) =>
    current.map((currentFile, fileIndex) =>
      fileIndex === index ? file : currentFile,
    ),
  );
}
