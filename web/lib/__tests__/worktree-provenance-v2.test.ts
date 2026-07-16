import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readWorktreeProvenanceMetadata } from "@/lib/worktree-provenance";

const createdPaths: string[] = [];

async function writeProvenance(contents: string): Promise<string> {
  const worktreePath = await mkdtemp(
    path.join(tmpdir(), "maister-provenance-v2-"),
  );
  const directory = path.join(worktreePath, ".maister-managed");

  createdPaths.push(worktreePath);
  await mkdir(directory);
  await writeFile(path.join(directory, "provenance"), contents);

  return worktreePath;
}

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((entry) =>
      rm(entry, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("worktree provenance v2", () => {
  it("parses the complete, versioned ownership evidence required for reconciliation", async () => {
    const worktreePath = await writeProvenance(
      [
        "version=2",
        "runId=run-1",
        "parentRepoPath=/repos/project",
        "projectId=project-1",
        "branch=maister/run-1",
        "workspaceKind=flow",
        "createdAt=2026-07-16T12:00:00.000Z",
        "task=MAI-1",
        "flow=release@abc123",
        "",
      ].join("\n"),
    );

    await expect(readWorktreeProvenanceMetadata(worktreePath)).resolves.toEqual(
      {
        version: 2,
        runId: "run-1",
        parentRepoPath: "/repos/project",
        projectId: "project-1",
        branch: "maister/run-1",
        workspaceKind: "flow",
        createdAt: "2026-07-16T12:00:00.000Z",
        task: "MAI-1",
        flow: "release@abc123",
      },
    );
  });

  it("rejects incomplete v2 metadata instead of granting autonomous cleanup authority", async () => {
    const worktreePath = await writeProvenance(
      [
        "version=2",
        "runId=run-1",
        "parentRepoPath=/repos/project",
        "projectId=project-1",
        "branch=maister/run-1",
        "workspaceKind=flow",
        "",
      ].join("\n"),
    );

    await expect(
      readWorktreeProvenanceMetadata(worktreePath),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });
});
