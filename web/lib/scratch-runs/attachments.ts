import "server-only";

import type { ScratchAttachmentInput } from "@/lib/scratch-runs/types";

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
