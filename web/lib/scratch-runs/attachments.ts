import "server-only";

import type {
  ScratchAttachmentInput,
  ScratchUploadedFileInput,
  StoredScratchAttachment,
} from "@/lib/scratch-runs/types";

import { createHash } from "node:crypto";
import path from "node:path";

import { MaisterError } from "@/lib/errors";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function resolveScratchAttachmentPath(args: {
  value: string;
  projectRepoPath: string;
  worktreePath: string;
}): string {
  const candidate = path.resolve(args.worktreePath, args.value);
  const repoPath = path.resolve(args.projectRepoPath);
  const worktreePath = path.resolve(args.worktreePath);

  if (isInside(repoPath, candidate) || isInside(worktreePath, candidate)) {
    return candidate;
  }

  throw new MaisterError(
    "PRECONDITION",
    `attachment file_path is outside project/worktree: ${args.value}`,
  );
}

export function validateScratchAttachments(
  attachments: readonly ScratchAttachmentInput[],
  paths: { projectRepoPath: string; worktreePath: string },
): ScratchAttachmentInput[] {
  return attachments.map((attachment) => {
    if (attachment.kind !== "file_path") return { ...attachment };

    return {
      ...attachment,
      value: resolveScratchAttachmentPath({
        value: attachment.value,
        ...paths,
      }),
    };
  });
}

export function safeUploadFileName(fileName: string): string {
  const trimmed = fileName.trim();

  if (
    trimmed.length === 0 ||
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed !== path.basename(trimmed) ||
    trimmed !== path.win32.basename(trimmed)
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `invalid upload filename: ${fileName}`,
    );
  }

  const safeName = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);

  if (safeName.length === 0 || safeName === "." || safeName === "..") {
    throw new MaisterError(
      "PRECONDITION",
      `invalid upload filename: ${fileName}`,
    );
  }

  return safeName;
}

export function uploadArtifactRef(args: {
  projectSlug: string;
  runId: string;
  scope: string;
  safeFileName: string;
}): string {
  return path.posix.join(
    ".maister",
    args.projectSlug,
    "runs",
    args.runId,
    "uploads",
    args.scope,
    args.safeFileName,
  );
}

export function uploadStoragePath(args: {
  runtimeRoot: string;
  artifactRef: string;
}): string {
  const storagePath = path.resolve(args.runtimeRoot, args.artifactRef);
  const rootPath = path.resolve(args.runtimeRoot);

  if (!isInside(rootPath, storagePath)) {
    throw new MaisterError(
      "PRECONDITION",
      `upload storage path is outside runtime root: ${args.artifactRef}`,
    );
  }

  return storagePath;
}

export function uploadedFileMetadata(args: {
  file: ScratchUploadedFileInput;
  projectSlug: string;
  runId: string;
  scope: string;
  runtimeRoot: string;
}): StoredScratchAttachment {
  const safeFileName = safeUploadFileName(args.file.fileName);
  const artifactRef = uploadArtifactRef({
    projectSlug: args.projectSlug,
    runId: args.runId,
    scope: args.scope,
    safeFileName,
  });
  const storagePath = uploadStoragePath({
    runtimeRoot: args.runtimeRoot,
    artifactRef,
  });

  return {
    kind: "uploaded_file",
    label: args.file.fileName,
    value: artifactRef,
    fileName: safeFileName,
    mimeType: args.file.mimeType || "application/octet-stream",
    byteSize: args.file.byteSize,
    sha256: createHash("sha256").update(args.file.bytes).digest("hex"),
    storagePath,
  };
}

export function metadataAttachmentRow(
  attachment: ScratchAttachmentInput,
): StoredScratchAttachment {
  return {
    kind: attachment.kind,
    label: attachment.label ?? null,
    value: attachment.value,
    fileName: null,
    mimeType: null,
    byteSize: null,
    sha256: null,
    storagePath: null,
  };
}
