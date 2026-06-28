import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { CompositionKind } from "@/lib/local-packages/composition";

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

// Pure, client-safe per-kind IDENTITY rename (ADR-115 P6, D8). Renames an
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
      const files = rewritten.map((f) =>
        f.path === PACKAGE_MANIFEST_FILENAME
          ? { ...f, content: nextManifest }
          : f,
      );

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
