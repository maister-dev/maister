import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

// Client-safe (NO server-only): the working-dir save planner + executor used by
// the local-package editor. The editor reuses FlowEditorTabs, whose save form
// submits a single blob (`flowYaml` + `packageFilesJson` + `title`). The
// working-dir backend is per-file instead (PUT/DELETE `/files/<path>`, each
// lock-guarded), so this module diffs the submitted set against the originals
// and emits the minimal set of writes. The lock id is never the session id —
// `working_dir`/`installedPath` never appear here (server-only, by contract).

export type WorkingDirFile = { path: string; content: string };

export type WorkingDirWrite =
  | { op: "put"; path: string; content: string }
  | { op: "delete"; path: string };

// Diff submitted files against the originals. A new or content-changed path →
// PUT; an original path missing from the submitted set → DELETE. Paths present
// in both with identical content are skipped (no spurious write / no churn).
export function planWorkingDirWrites(
  original: readonly WorkingDirFile[],
  submitted: readonly WorkingDirFile[],
): WorkingDirWrite[] {
  const originalByPath = new Map(original.map((f) => [f.path, f.content]));
  const submittedPaths = new Set(submitted.map((f) => f.path));
  const writes: WorkingDirWrite[] = [];

  for (const file of submitted) {
    const prev = originalByPath.get(file.path);

    if (prev === undefined || prev !== file.content) {
      writes.push({ op: "put", path: file.path, content: file.content });
    }
  }

  for (const file of original) {
    if (!submittedPaths.has(file.path)) {
      writes.push({ op: "delete", path: file.path });
    }
  }

  return writes;
}

// Overlay the canvas/YAML buffer (`flowYaml`) onto the submitted file set for the
// selected flow path. The canvas is authoritative for the file currently open in
// the editor, so its buffer wins over the Files-drawer copy of the same path.
export function overlayFlowBuffer(
  submitted: readonly WorkingDirFile[],
  flowPath: string | null,
  flowYaml: string,
): WorkingDirFile[] {
  if (!flowPath) return [...submitted];

  let replaced = false;
  const next = submitted.map((file) => {
    if (file.path === flowPath) {
      replaced = true;

      return { path: file.path, content: flowYaml };
    }

    return file;
  });

  if (!replaced) next.push({ path: flowPath, content: flowYaml });

  return next;
}

// Parse the `packageFilesJson` hidden input the PackageFilesEditor submits. A
// malformed/absent value yields the originals unchanged (no destructive diff).
export function parsePackageFilesJson(
  raw: FormDataEntryValue | null,
  fallback: readonly AuthoredFlowPackageFile[],
): WorkingDirFile[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback.map((f) => ({ path: f.path, content: f.content }));
  }
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return fallback.map((f) => ({ path: f.path, content: f.content }));
    }

    return parsed
      .filter(
        (e): e is { path: string; content: string } =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as { path?: unknown }).path === "string" &&
          typeof (e as { content?: unknown }).content === "string",
      )
      .map((e) => ({ path: e.path, content: e.content }));
  } catch {
    return fallback.map((f) => ({ path: f.path, content: f.content }));
  }
}
