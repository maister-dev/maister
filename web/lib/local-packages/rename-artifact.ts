import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { CompositionKind } from "@/lib/local-packages/composition";

import { parseDocument } from "yaml";

import { renamePackageFilePath } from "@/lib/flows/editor/package-files-draft";
import {
  flowCanvasHref,
  inlineSelectHref,
  skillScreenHref,
  skillSubtreePrefix,
} from "@/lib/local-packages/composition";
import {
  appendManifestFlow,
  PACKAGE_MANIFEST_FILENAME,
  parsePackageManifest,
  renameManifestFlow,
} from "@/lib/local-packages/manifest";

// Pure, client-safe per-kind IDENTITY rename (ADR-116 P6, D8). Renames an
// artifact's file/folder (the id derives from filename/folder) — distinct from
// editing its metadata (frontmatter), which happens in the editor. Operates on
// the flat draft list; a flow rename ALSO rewrites `manifest.spec.flows[]`; a
// skill rename rewrites the prefix of every child. Collisions reject; frontmatter
// is never touched.

export type RenameResult =
  | { ok: true; files: AuthoredFlowPackageFile[]; navigate: string }
  | {
      ok: false;
      code: "CONFLICT" | "PRECONDITION" | "CONFIG";
      message: string;
    };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(
  code: "CONFLICT" | "PRECONDITION" | "CONFIG",
  message: string,
): RenameResult {
  return { ok: false, code, message };
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");

  return slash >= 0 ? path.slice(0, slash) : "";
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  return dot > 0 ? base.slice(dot) : "";
}

// Set a flow.yaml's top-level `name` while preserving comments + key order
// (parseDocument, not parse/stringify). Returns null when the YAML is unparseable
// so the caller fails the rename rather than shipping a stale name. The installer
// rejects a package whose flow.yaml `name` != its manifest flow `id`
// (lib/packages/install.ts), so a flow identity rename MUST move the manifest id,
// the dir, AND this name together — updating only the first two cuts an
// uncuttable package.
function setFlowYamlName(content: string, newName: string): string | null {
  let doc;

  try {
    doc = parseDocument(content);
  } catch {
    return null;
  }
  if (doc.errors.length > 0) return null;
  doc.set("name", newName);

  return String(doc);
}

function renameSingleFile(
  draftFiles: AuthoredFlowPackageFile[],
  oldPath: string,
  newPath: string,
  packageId: string,
  kind: CompositionKind,
  newId: string,
): RenameResult {
  if (!draftFiles.some((f) => f.path === oldPath)) {
    return fail("PRECONDITION", `not found: ${oldPath}`);
  }
  if (newPath !== oldPath && draftFiles.some((f) => f.path === newPath)) {
    return fail("CONFLICT", newPath);
  }

  return {
    ok: true,
    files: renamePackageFilePath(draftFiles, oldPath, newPath),
    navigate: inlineSelectHref(packageId, kind, newId),
  };
}

// Rewrite every file under `oldPrefix` to `newPrefix` (folder rename). Rejects if
// any destination path already exists outside the moved set.
function rewritePrefix(
  draftFiles: AuthoredFlowPackageFile[],
  oldPrefix: string,
  newPrefix: string,
): AuthoredFlowPackageFile[] | { conflict: string } {
  const moved = new Set<string>();
  const next: AuthoredFlowPackageFile[] = [];

  for (const file of draftFiles) {
    if (file.path.startsWith(oldPrefix)) {
      moved.add(newPrefix + file.path.slice(oldPrefix.length));
    }
  }
  for (const file of draftFiles) {
    if (file.path.startsWith(newPrefix) && !file.path.startsWith(oldPrefix)) {
      return { conflict: newPrefix };
    }
  }
  for (const file of draftFiles) {
    if (file.path.startsWith(oldPrefix)) {
      next.push({
        ...file,
        path: newPrefix + file.path.slice(oldPrefix.length),
      });
    } else {
      next.push(file);
    }
  }

  return moved.size > 0 ? next : { conflict: oldPrefix };
}

export function renameArtifact(opts: {
  kind: CompositionKind;
  id: string;
  // The element's current working-dir path (BOM card path): a file for single-file
  // kinds, the `flows/<id>` dir for flows, the `skills/<id>` dir for skills.
  path: string;
  newName: string;
  packageId: string;
  draftFiles: AuthoredFlowPackageFile[];
}): RenameResult {
  const newName = opts.newName.trim();

  if (!NAME_RE.test(newName)) {
    return fail(
      "PRECONDITION",
      `invalid name: ${JSON.stringify(opts.newName)}`,
    );
  }

  const { kind, id, path, packageId, draftFiles } = opts;

  switch (kind) {
    case "rules":
    case "agents":
    case "subagents":
    case "mcps": {
      const ext = extOf(path);
      const dir = dirOf(path);
      const newPath = dir ? `${dir}/${newName}${ext}` : `${newName}${ext}`;
      const newId = kind === "rules" ? `${newName}${ext}` : newName;

      return renameSingleFile(
        draftFiles,
        path,
        newPath,
        packageId,
        kind,
        newId,
      );
    }
    case "skills": {
      const oldPrefix = skillSubtreePrefix(id);
      const newPrefix = skillSubtreePrefix(newName);
      const rewritten = rewritePrefix(draftFiles, oldPrefix, newPrefix);

      if ("conflict" in rewritten) {
        return rewritten.conflict === oldPrefix
          ? fail("PRECONDITION", `not found: ${oldPrefix}`)
          : fail("CONFLICT", newPrefix);
      }

      return {
        ok: true,
        files: rewritten,
        navigate: skillScreenHref(packageId, newName),
      };
    }
    case "flows": {
      const oldPrefix = `${path.replace(/\/+$/, "")}/`;
      const newPrefix = `flows/${newName}/`;
      const rewritten = rewritePrefix(draftFiles, oldPrefix, newPrefix);

      if ("conflict" in rewritten) {
        return rewritten.conflict === oldPrefix
          ? fail("PRECONDITION", `not found: ${oldPrefix}`)
          : fail("CONFLICT", newPrefix);
      }

      const manifestFile = rewritten.find(
        (f) => f.path === PACKAGE_MANIFEST_FILENAME,
      );
      const parsed = parsePackageManifest(manifestFile?.content ?? "");

      if (!parsed.ok) {
        return fail("CONFIG", `manifest unparseable: ${parsed.error}`);
      }

      // Update the manifest flow entry (id + path). If the old id was not listed,
      // append the new one so the renamed flow is never orphaned.
      const hasOld = parsed.model.flows.some((f) => f.id === id);
      const nextManifest = hasOld
        ? renameManifestFlow(parsed.raw, id, {
            id: newName,
            path: `flows/${newName}`,
          })
        : appendManifestFlow(parsed.raw, {
            id: newName,
            path: `flows/${newName}`,
          });

      // The manifest flow id now reads `newName`; the moved flow.yaml's `name`
      // MUST match it (installer invariant). Rewrite it in the same draft op; an
      // unparseable flow.yaml fails the rename rather than shipping a stale name.
      const flowYamlPath = `${newPrefix}flow.yaml`;
      const files: AuthoredFlowPackageFile[] = [];

      for (const f of rewritten) {
        if (f.path === PACKAGE_MANIFEST_FILENAME) {
          files.push({ ...f, content: nextManifest });
          continue;
        }
        if (f.path === flowYamlPath) {
          const synced = setFlowYamlName(f.content, newName);

          if (synced === null) {
            return fail("CONFIG", `flow.yaml unparseable: ${flowYamlPath}`);
          }
          files.push({ ...f, content: synced });
          continue;
        }
        files.push(f);
      }

      return {
        ok: true,
        files,
        navigate: flowCanvasHref(packageId, `flows/${newName}`),
      };
    }
    default:
      return fail("PRECONDITION", `cannot rename kind: ${kind}`);
  }
}
