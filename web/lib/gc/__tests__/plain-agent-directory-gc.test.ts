import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

vi.mock("@/lib/instance-config", () => ({
  worktreesRoot: () => root,
}));

import {
  removeOwnedPlainAgentDirectory,
  runPlainAgentDirectoryGcSweep,
} from "../plain-agent-directory-gc";

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "plain-agent-directory-gc-")),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("plain agent directory cleanup", () => {
  it("restores materialization before removing a terminal workspace=none directory", async () => {
    const runId = "run-1";
    const directoryPath = path.join(root, "project", runId);
    const order: string[] = [];

    await mkdir(directoryPath, { recursive: true });
    await writeFile(path.join(directoryPath, "ephemeral.txt"), "cleanup\n");

    const summary = await runPlainAgentDirectoryGcSweep({
      candidates: [{ runId, projectSlug: "project", status: "Done" }],
      restoreMaterialization: vi.fn(async () => {
        order.push("restore");
      }),
      removeDirectory: async (args) => {
        order.push("remove");

        return removeOwnedPlainAgentDirectory(args);
      },
    });

    expect(summary).toEqual({ scanned: 1, removed: 1, missing: 0, failed: 0 });
    expect(order).toEqual(["restore", "remove"]);
    await expect(stat(directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a missing terminal directory as an idempotent outcome", async () => {
    await expect(
      runPlainAgentDirectoryGcSweep({
        candidates: [
          { runId: "run-1", projectSlug: "project", status: "Done" },
        ],
        restoreMaterialization: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({ scanned: 1, removed: 0, missing: 1, failed: 0 });
  });

  it("refuses a project-root symlink that would escape the managed worktrees root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "plain-agent-outside-"));
    const outsideRun = path.join(outside, "run-1");

    await mkdir(outsideRun, { recursive: true });
    await symlink(outside, path.join(root, "project"));

    const summary = await runPlainAgentDirectoryGcSweep({
      candidates: [{ runId: "run-1", projectSlug: "project", status: "Done" }],
      restoreMaterialization: vi.fn(async () => undefined),
    });

    expect(summary).toEqual({ scanned: 1, removed: 0, missing: 0, failed: 1 });
    await expect(stat(outsideRun)).resolves.toBeDefined();

    await rm(outside, { recursive: true, force: true });
  });
});
