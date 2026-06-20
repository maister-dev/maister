"use client";

import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

export type ImportDialogLabels = {
  title: string;
  pickFolder: string;
  pickArchive: string;
  folderHint: string;
  archiveHint: string;
  previewTitle: string;
  previewCount: string; // "$count files · $bytes" (placeholders replaced client-side)
  empty: string;
  cancel: string;
  back: string;
  importBtn: string;
  importing: string;
  done: string;
  lockedByOther: string;
};

// Build the dialog labels from a `studio`-scoped translator (keys under
// `studio.import.*`). Shared by the list + editor triggers so the mapping lives
// in one place. The count/byte/done strings are interpolated client-side
// (placeholder replacement) so the raw template is passed through verbatim.
export function buildImportDialogLabels(
  t: (key: string) => string,
): ImportDialogLabels {
  return {
    title: t("import.title"),
    pickFolder: t("import.pickFolder"),
    pickArchive: t("import.pickArchive"),
    folderHint: t("import.folderHint"),
    archiveHint: t("import.archiveHint"),
    previewTitle: t("import.previewTitle"),
    previewCount: t("import.previewCount"),
    empty: t("import.empty"),
    cancel: t("import.cancel"),
    back: t("import.back"),
    importBtn: t("import.importBtn"),
    importing: t("import.importing"),
    done: t("import.done"),
    lockedByOther: t("import.lockedByOther"),
  };
}

type PlanFile = { path: string; size: number };
type Step =
  | { kind: "pick" }
  | { kind: "previewing" }
  | { kind: "preview"; files: PlanFile[]; totalBytes: number }
  | { kind: "committing" }
  | { kind: "done"; count: number }
  | { kind: "error"; message: string };

// A folder member (relative path + blob) OR a single archive blob, staged
// client-side before upload. `webkitRelativePath` carries the folder structure;
// FormData drops it, so it is sent as a parallel `paths` array.
type Staged =
  | { kind: "folder"; files: { relativePath: string; file: File }[] }
  | { kind: "archive"; file: File };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;

  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Batch-import dialog (M36 T3.2). Folder (directory picker) OR archive (zip /
 * tar.gz). Two-phase: a `preview` call resolves the confined tree without
 * writing, then `commit` writes under the session lock.
 *
 * `sessionId`: when opened from the editor the held lock's session is passed in
 * and reused; when opened from the list (no prop) the dialog generates its own
 * session and acquires the lock via /lock-refresh right before commit.
 */
export function ImportDialog({
  packageId,
  sessionId,
  labels,
  onClose,
  onImported,
}: {
  packageId: string;
  sessionId?: string;
  labels: ImportDialogLabels;
  onClose: () => void;
  onImported?: () => void;
}): ReactElement {
  const router = useRouter();
  const tApiErrors = useTranslations("apiErrors");
  const [staged, setStaged] = useState<Staged | null>(null);
  const [step, setStep] = useState<Step>({ kind: "pick" });

  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  // Stable per-mount session id used only when no editor session was provided.
  const ownSessionRef = useRef<string>("");

  if (ownSessionRef.current === "") {
    ownSessionRef.current =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `imp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function onFolderPick(fileList: FileList | null): void {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).map((file) => ({
      // webkitRelativePath includes the chosen dir name as the first segment
      // (e.g. "mydir/flows/a.yaml"); keep it — the confinement gate handles it.
      relativePath: file.webkitRelativePath || file.name,
      file,
    }));

    setStaged({ kind: "folder", files });
    setStep({ kind: "pick" });
  }

  function onArchivePick(fileList: FileList | null): void {
    const file = fileList?.[0];

    if (!file) return;
    setStaged({ kind: "archive", file });
    setStep({ kind: "pick" });
  }

  function buildForm(mode: "preview" | "commit", session: string): FormData {
    const form = new FormData();

    form.set("mode", mode);
    form.set("sessionId", session);

    if (staged?.kind === "folder") {
      form.set("kind", "folder");
      form.set(
        "paths",
        JSON.stringify(staged.files.map((f) => f.relativePath)),
      );
      for (const f of staged.files) form.append("files", f.file);
    } else if (staged?.kind === "archive") {
      form.set("kind", "archive");
      form.append("files", staged.file);
    }

    return form;
  }

  async function runPreview(): Promise<void> {
    if (!staged) return;
    setStep({ kind: "previewing" });
    try {
      const res = await fetch(
        `/api/studio/local-packages/${packageId}/import`,
        { method: "POST", body: buildForm("preview", ownSessionRef.current) },
      );

      if (!res.ok) {
        setStep({
          kind: "error",
          message: await readApiError(res, tApiErrors),
        });

        return;
      }
      const plan = (await res.json()) as {
        files: PlanFile[];
        totalBytes: number;
      };

      setStep({
        kind: "preview",
        files: plan.files,
        totalBytes: plan.totalBytes,
      });
    } catch (err) {
      setStep({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Resolve the session to commit under: the editor's (lock already held) or,
  // from the list, this dialog's own session — acquired via /lock-refresh. A
  // foreign live lock surfaces as `lockedByOther` (commit would CONFLICT).
  async function resolveCommitSession(): Promise<string | null> {
    if (sessionId) return sessionId;
    const res = await fetch(
      `/api/studio/local-packages/${packageId}/lock-refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: ownSessionRef.current }),
      },
    );

    if (!res.ok) {
      setStep({ kind: "error", message: await readApiError(res, tApiErrors) });

      return null;
    }
    const lock = (await res.json()) as { heldByMe: boolean };

    if (!lock.heldByMe) {
      setStep({ kind: "error", message: labels.lockedByOther });

      return null;
    }

    return ownSessionRef.current;
  }

  async function runCommit(): Promise<void> {
    if (!staged) return;
    setStep({ kind: "committing" });
    const session = await resolveCommitSession();

    if (!session) return;
    try {
      const res = await fetch(
        `/api/studio/local-packages/${packageId}/import`,
        { method: "POST", body: buildForm("commit", session) },
      );

      if (!res.ok) {
        setStep({
          kind: "error",
          message: await readApiError(res, tApiErrors),
        });

        return;
      }
      const plan = (await res.json()) as { files: PlanFile[] };

      setStep({ kind: "done", count: plan.files.length });
      onImported?.();
      router.refresh();
    } catch (err) {
      setStep({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const busy = step.kind === "previewing" || step.kind === "committing";

  return (
    <div
      aria-labelledby="import-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
    >
      <div
        ref={dialogRef}
        className="flex max-h-[80vh] w-full max-w-[560px] flex-col rounded-[16px] border border-line bg-paper p-6 shadow-xl"
      >
        <h3
          className="m-0 mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute"
          id="import-dialog-title"
        >
          {labels.title}
        </h3>

        {step.kind === "done" ? (
          <DoneView count={step.count} labels={labels} onClose={onClose} />
        ) : (
          <div className="flex min-h-0 flex-col gap-4">
            {(step.kind === "pick" ||
              step.kind === "previewing" ||
              step.kind === "error") && (
              <Pickers
                busy={busy}
                labels={labels}
                staged={staged}
                onArchivePick={onArchivePick}
                onFolderPick={onFolderPick}
              />
            )}

            {step.kind === "preview" && (
              <PreviewTree
                files={step.files}
                labels={labels}
                totalBytes={step.totalBytes}
              />
            )}

            {step.kind === "error" && (
              <p
                className="m-0 rounded-[10px] border border-danger-line bg-danger-soft px-3 py-2 text-[12px] text-danger"
                data-testid="import-error"
                role="alert"
              >
                {step.message}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                className="h-9 rounded-[8px] border border-line px-3 text-[12.5px] font-semibold text-ink hover:bg-ivory disabled:opacity-50"
                disabled={busy}
                type="button"
                onClick={onClose}
              >
                {labels.cancel}
              </button>

              {step.kind === "preview" ? (
                <>
                  <button
                    className="h-9 rounded-[8px] border border-line px-3 text-[12.5px] font-semibold text-ink hover:bg-ivory"
                    type="button"
                    onClick={() => setStep({ kind: "pick" })}
                  >
                    {labels.back}
                  </button>
                  <button
                    className="h-9 rounded-[8px] border border-amber bg-amber px-4 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-50"
                    data-testid="import-commit"
                    disabled={step.files.length === 0}
                    type="button"
                    onClick={() => void runCommit()}
                  >
                    {labels.importBtn}
                  </button>
                </>
              ) : (
                <button
                  className="h-9 rounded-[8px] border border-amber bg-amber px-4 text-[12.5px] font-semibold text-white hover:bg-amber-2 disabled:opacity-50"
                  data-testid="import-preview"
                  disabled={!staged || busy}
                  type="button"
                  onClick={() => void runPreview()}
                >
                  {busy ? labels.importing : labels.previewTitle}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Pickers({
  staged,
  busy,
  labels,
  onFolderPick,
  onArchivePick,
}: {
  staged: Staged | null;
  busy: boolean;
  labels: ImportDialogLabels;
  onFolderPick: (f: FileList | null) => void;
  onArchivePick: (f: FileList | null) => void;
}): ReactElement {
  const stagedSummary =
    staged?.kind === "folder"
      ? `${staged.files.length}`
      : staged?.kind === "archive"
        ? staged.file.name
        : null;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
          {labels.pickFolder}
        </span>
        {/* webkitdirectory is non-standard; the cast keeps strict TS happy. */}
        <input
          multiple
          className="text-[12px] text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-ivory file:px-3 file:py-1.5 file:text-[12px] file:font-semibold file:text-ink"
          data-testid="import-folder-input"
          disabled={busy}
          type="file"
          onChange={(e) => onFolderPick(e.target.files)}
          {...({ webkitdirectory: "", directory: "" } as Record<
            string,
            string
          >)}
        />
        <span className="text-[11px] text-mute">{labels.folderHint}</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
          {labels.pickArchive}
        </span>
        <input
          accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
          className="text-[12px] text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-ivory file:px-3 file:py-1.5 file:text-[12px] file:font-semibold file:text-ink"
          data-testid="import-archive-input"
          disabled={busy}
          type="file"
          onChange={(e) => onArchivePick(e.target.files)}
        />
        <span className="text-[11px] text-mute">{labels.archiveHint}</span>
      </label>

      {stagedSummary ? (
        <p
          className="m-0 truncate font-mono text-[11.5px] text-ink-2"
          data-testid="import-staged"
        >
          {stagedSummary}
        </p>
      ) : null}
    </div>
  );
}

function PreviewTree({
  files,
  totalBytes,
  labels,
}: {
  files: PlanFile[];
  totalBytes: number;
  labels: ImportDialogLabels;
}): ReactElement {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <p
        className="m-0 font-mono text-[11px] text-mute"
        data-testid="import-summary"
      >
        {labels.previewCount
          .replace("$count", String(files.length))
          .replace("$bytes", fmtBytes(totalBytes))}
      </p>
      {files.length === 0 ? (
        <p className="m-0 text-[12px] text-mute">{labels.empty}</p>
      ) : (
        <ul
          className="m-0 max-h-[320px] list-none overflow-auto rounded-[10px] border border-line bg-ivory p-2"
          data-testid="import-tree"
        >
          {files.map((f) => (
            <li
              key={f.path}
              className="flex items-center justify-between gap-3 px-2 py-1 font-mono text-[11.5px] text-ink"
            >
              <span className="truncate">{f.path}</span>
              <span className="shrink-0 text-mute">{fmtBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DoneView({
  count,
  labels,
  onClose,
}: {
  count: number;
  labels: ImportDialogLabels;
  onClose: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <p
        className="m-0 flex items-center gap-2 rounded-[10px] border border-line bg-ivory px-3 py-2 text-[12.5px] text-good"
        data-testid="import-done"
        role="status"
      >
        <span aria-hidden>✓</span>{" "}
        {labels.done.replace("$count", String(count))}
      </p>
      <div className="flex justify-end">
        <button
          className="h-9 rounded-[8px] border border-line px-3 text-[12.5px] font-semibold text-ink hover:bg-ivory"
          type="button"
          onClick={onClose}
        >
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}
