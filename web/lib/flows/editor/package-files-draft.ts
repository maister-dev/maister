import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";

export function upsertPackageFile(
  files: readonly AuthoredFlowPackageFile[],
  path: string,
  content: string,
): AuthoredFlowPackageFile[] {
  const nextFile: AuthoredFlowPackageFile = {
    kind: classifyPackageFilePath(path),
    path,
    content,
  };
  const replaced = files.map((file) =>
    file.path === path ? nextFile : { ...file },
  );

  if (files.some((file) => file.path === path)) return replaced;

  return [...replaced, nextFile];
}

export function removePackageFile(
  files: readonly AuthoredFlowPackageFile[],
  path: string,
): AuthoredFlowPackageFile[] {
  return files
    .filter((file) => file.path !== path)
    .map((file) => ({ ...file, kind: classifyPackageFilePath(file.path) }));
}

export function renamePackageFilePath(
  files: readonly AuthoredFlowPackageFile[],
  oldPath: string,
  newPath: string,
): AuthoredFlowPackageFile[] {
  return files.map((file) =>
    file.path === oldPath
      ? {
          ...file,
          path: newPath,
          kind: classifyPackageFilePath(newPath),
        }
      : { ...file, kind: classifyPackageFilePath(file.path) },
  );
}

export function replacePackageFileContent(
  files: readonly AuthoredFlowPackageFile[],
  path: string,
  content: string,
): AuthoredFlowPackageFile[] {
  return files.map((file) =>
    file.path === path
      ? { ...file, kind: classifyPackageFilePath(file.path), content }
      : { ...file, kind: classifyPackageFilePath(file.path) },
  );
}

export function packageFilesToSubmitValue(
  files: readonly AuthoredFlowPackageFile[],
): string {
  return JSON.stringify(files);
}
