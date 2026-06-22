import type {
  AuthoredFlowPackageFile,
  AuthoredFlowPackageFileKind,
} from "@/lib/catalog/authored-types";

// Client-safe kind inference shared by the package-files editor and the
// server-side reader/import/bridge. Lives here (no `server-only`) so the client
// editor can derive the read-only inferred-kind badge without forking the rules;
// `@/lib/flows/package-authoring` re-exports this as `classifyPackageFile`.
export function classifyPackageFilePath(
  relativePath: string,
): AuthoredFlowPackageFileKind {
  if (relativePath === "README.md") return "readme";
  if (relativePath === "maister-package.yaml") return "manifest";
  if (relativePath === "setup.sh") return "setup";
  if (relativePath.startsWith("schemas/")) return "schema";
  if (relativePath.startsWith("skills/")) return "skill";
  if (relativePath.startsWith("rules/")) return "rule";
  // Package-root `maister-agents/` are platform-agent definitions (structural
  // editor + rich view). Capability subagents at `capability/**/agents/` are NOT
  // matched here (they fall through to "asset" = raw) — they are Claude
  // subagents materialized into `.claude/` at run, not platform-agents.
  if (relativePath.startsWith("maister-agents/")) return "agent_definition";
  if (relativePath.startsWith("agents/")) return "agent_definition";
  if (relativePath.startsWith("scripts/")) return "script";
  if (relativePath.startsWith("templates/")) return "template";

  return "asset";
}

export type FileTreeFileNode = {
  type: "file";
  name: string;
  path: string;
  kind: AuthoredFlowPackageFileKind;
};

export type FileTreeFolderNode = {
  type: "folder";
  name: string;
  path: string;
  children: FileTreeNode[];
};

export type FileTreeNode = FileTreeFolderNode | FileTreeFileNode;

// Groups a flat `files[{path,content}]` list into a derived folder tree by path
// segments. Folders sort before files; both alphabetical by name within a level.
// Kind is inferred per leaf via `classifyPackageFilePath` (never read from the
// stored model). Pure: never mutates `files`.
export function buildFileTree(
  files: readonly AuthoredFlowPackageFile[],
): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const segments = file.path
      .split("/")
      .filter((segment) => segment.length > 0);

    if (segments.length === 0) continue;

    let level = root;
    let prefix = "";

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];

      prefix = prefix.length > 0 ? `${prefix}/${segment}` : segment;

      if (index === segments.length - 1) {
        level.push({
          type: "file",
          name: segment,
          path: file.path,
          kind: classifyPackageFilePath(file.path),
        });

        break;
      }

      let folder = level.find(
        (node): node is FileTreeFolderNode =>
          node.type === "folder" && node.name === segment,
      );

      if (!folder) {
        folder = { type: "folder", name: segment, path: prefix, children: [] };
        level.push(folder);
      }

      level = folder.children;
    }
  }

  return sortTreeLevel(root);
}

function sortTreeLevel(nodes: FileTreeNode[]): FileTreeNode[] {
  for (const node of nodes) {
    if (node.type === "folder") sortTreeLevel(node.children);
  }

  return nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;

    return left.name.localeCompare(right.name);
  });
}

export type PathEditValidation =
  | { ok: true; path: string; kind: AuthoredFlowPackageFileKind }
  | { ok: false; code: "unsafe_path" | "duplicate_path" | "path_conflict" };

// Validates a rename/move (full-path edit) of `oldPath → newPath` against the
// existing authored issue codes BEFORE the editor applies it. Mirrors the
// server `normalizePackageFiles` semantics (`unsafe_path`/`duplicate_path`/
// `path_conflict`) so the editor never produces a body the publish gate rejects.
// On success returns the normalized path + freshly inferred kind.
export function validatePathEdit(
  files: readonly AuthoredFlowPackageFile[],
  oldPath: string,
  newPath: string,
): PathEditValidation {
  const normalized = normalizePackagePath(newPath);

  if (!isSafePackagePath(newPath, normalized)) {
    return { ok: false, code: "unsafe_path" };
  }

  const others = files.filter((file) => file.path !== oldPath);

  if (others.some((file) => normalizePackagePath(file.path) === normalized)) {
    return { ok: false, code: "duplicate_path" };
  }

  if (
    others.some((file) =>
      hasPackagePathConflict(normalizePackagePath(file.path), normalized),
    )
  ) {
    return { ok: false, code: "path_conflict" };
  }

  return {
    ok: true,
    path: normalized,
    kind: classifyPackageFilePath(normalized),
  };
}

function normalizePackagePath(value: string): string {
  return normalizePosix(value.replaceAll("\\", "/"));
}

// posix.normalize without `node:path` (this module is client-bundled): collapse
// `.` and resolvable `..` segments, preserve a single leading "..".
function normalizePosix(value: string): string {
  const isAbsolute = value.startsWith("/");
  const segments = value.split("/");
  const out: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolute) {
        out.push("..");
      }

      continue;
    }

    out.push(segment);
  }

  const joined = out.join("/");

  if (isAbsolute) return `/${joined}`;

  return joined.length > 0 ? joined : ".";
}

function isSafePackagePath(original: string, normalizedPath: string): boolean {
  if (original.startsWith("/") || original.startsWith("\\")) return false;
  if (hasControlChar(original)) return false;
  if (original.replaceAll("\\", "/").split("/").includes("..")) return false;
  if (normalizedPath === "." || normalizedPath.length === 0) return false;
  if (normalizedPath.startsWith("../") || normalizedPath === "..") return false;

  return !normalizedPath.split("/").includes("..");
}

// NUL and other control characters never belong in a package path. Checked by
// code point so the source carries no literal control bytes.
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x20 || code === 0x7f) return true;
  }

  return false;
}

function hasPackagePathConflict(left: string, right: string): boolean {
  if (left === right) return false;

  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
