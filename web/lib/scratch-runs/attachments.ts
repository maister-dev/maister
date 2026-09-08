import "server-only";

import type {
  ScratchAttachmentInput,
  ScratchUploadedFileInput,
  StoredScratchAttachment,
} from "@/lib/scratch-runs/types";
import type { PromptContentBlock } from "@/lib/execution-host";

import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

export function scratchUploadLogicalName(input: {
  scope: string;
  fileName: string;
}): string {
  const scopeDigest = createHash("sha256")
    .update(input.scope, "utf8")
    .digest("hex")
    .slice(0, 16);

  return `scratch-upload-${scopeDigest}-${safeUploadFileName(input.fileName)}`;
}

export function uploadedFileMetadata(args: {
  file: ScratchUploadedFileInput;
  objectId: string;
}): StoredScratchAttachment {
  const safeFileName = safeUploadFileName(args.file.fileName);

  return {
    kind: "uploaded_file",
    label: args.file.fileName,
    // The database records the manager-visible opaque ID. Only the supervisor
    // resolves it to a private ACP file URI at prompt execution time.
    value: args.objectId,
    fileName: safeFileName,
    mimeType: args.file.mimeType || "application/octet-stream",
    byteSize: args.file.byteSize,
    sha256: createHash("sha256").update(args.file.bytes).digest("hex"),
    storagePath: null,
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

// Turn scratch attachments into prompt blocks. Uploaded files are opaque
// execution-object references; their host paths are deliberately unavailable to
// the manager. Repository file-path attachments remain a Stage C workspace
// concern and retain their existing confined file URI contract.
export function scratchPromptContentBlocks(
  text: string,
  attachments: readonly StoredScratchAttachment[],
): PromptContentBlock[] | undefined {
  const links: PromptContentBlock[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === "uploaded_file") {
      links.push({
        type: "runtime_object",
        objectId: attachment.value,
        name: attachment.fileName ?? attachment.label ?? "file",
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      });
    } else if (attachment.kind === "file_path") {
      links.push({
        type: "resource_link",
        uri: pathToFileURL(attachment.value).href,
        name: attachment.label ?? path.basename(attachment.value),
      });
    }
  }

  if (links.length === 0) return undefined;

  return [{ type: "text", text }, ...links];
}
